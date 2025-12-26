import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("🔌 Testing Supabase connection...");

// Test connection
(async () => {
  const { error } = await supabase.from("users").select("count");
  if (error) {
    console.error("❌ Supabase error:", error);
  } else {
    console.log("✅ Supabase connected");
  }
})();

// ============ HELPERS ============
async function getSettings() {
  const { data } = await supabase
    .from("lottery_settings")
    .select("*")
    .eq("is_active", true)
    .order("id", { ascending: false })
    .limit(1)
    .single();

  return (
    data || {
      lottery_round: 1,
      ticket_price: 101,
      total_tickets: 1000,
    }
  );
}

async function getTicketPrice() {
  const settings = await getSettings();
  return settings.ticket_price || 101;
}

async function getTotalTickets() {
  const settings = await getSettings();
  return settings.total_tickets || 1000;
}

async function getCurrentLotteryRound() {
  const settings = await getSettings();
  return settings.lottery_round || 1;
}

function generateRandomCode(length = 5) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function generateUniqueTicketCodes(quantity, lotteryRound) {
  const codes = [];
  let attempts = 0;
  const maxAttempts = quantity * 10;

  while (codes.length < quantity && attempts < maxAttempts) {
    attempts++;
    const randomPart = generateRandomCode(5);
    const ticketCode = `${lotteryRound}LOT-${randomPart}`;

    const { data } = await supabase
      .from("tickets")
      .select("ticket_code")
      .eq("ticket_code", ticketCode)
      .single();

    if (!data) {
      codes.push(ticketCode);
    }
  }

  return codes;
}

async function createGatewayOrder(orderId, amount, mobile, name) {
  try {
    console.log("📤 Gateway request:", { orderId, amount, mobile, name });

    const formData = new URLSearchParams();
    formData.append("customer_mobile", mobile);
    formData.append("user_token", process.env.GARUD_API_TOKEN);
    formData.append("amount", amount);
    formData.append("order_id", orderId);
    formData.append(
      "redirect_url",
      `${process.env.FRONTEND_SUCCESS_URL}?order_id=${orderId}&status=success`
    );
    formData.append("remark1", name);
    formData.append("remark2", "lottery_ticket");

    console.log("📦 Sending to gateway...");

    const res = await fetch("https://upifastpe.com/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    const responseText = await res.text();
    console.log("📥 Gateway raw response:", responseText);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error("❌ Invalid JSON response:", responseText);
      throw new Error("Invalid gateway response");
    }

    console.log("📥 Gateway parsed:", JSON.stringify(data, null, 2));

    // Check success
    const isSuccess =
      data.status === "SUCCESS" ||
      data.status === "success" ||
      data.status === true ||
      data.msg === "Order Created Successfully" ||
      data.message === "Order Created Successfully" ||
      (data.payment_url && data.payment_url !== "");

    if (!isSuccess) {
      const errorMsg =
        data?.msg || data?.message || data?.error || "Gateway rejected";
      console.error("❌ Gateway error:", errorMsg);
      throw new Error(errorMsg);
    }

    // Extract payment URL
    const paymentUrl =
      data.payment_url ||
      data.link ||
      data.payment_link ||
      data.data?.payment_url ||
      data.data?.link ||
      data.result?.payment_url;

    if (!paymentUrl) {
      console.error("❌ No payment URL found in:", data);
      throw new Error("No payment URL in response");
    }

    console.log("✅ Payment URL:", paymentUrl);
    return { ...data, payment_url: paymentUrl };
  } catch (err) {
    console.error("❌ Gateway function error:", err);
    throw err;
  }
}

async function getSoldTicketsCount() {
  const { count } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true });
  return count || 0;
}

// ============ ROUTES ============

app.get("/", (req, res) => {
  res.json({ status: "OK", time: new Date().toISOString() });
});

app.get("/api/tickets/remaining", async (req, res) => {
  try {
    const sold = await getSoldTicketsCount();
    const total = await getTotalTickets();
    res.json({ remaining: total - sold });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/create-order", async (req, res) => {
  try {
    const { name, mobile, quantity } = req.body;

    console.log("📝 Order:", { name, mobile, quantity });

    if (!name || !mobile || !quantity) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: "Invalid mobile" });
    }

    const ticketPrice = await getTicketPrice();
    const totalTickets = await getTotalTickets();
    const sold = await getSoldTicketsCount();

    if (totalTickets - sold < quantity) {
      return res.status(400).json({ error: "Not enough tickets" });
    }

    // Find or create user
    let { data: existingUsers } = await supabase
      .from("users")
      .select("*")
      .eq("mobile", mobile);

    let userId;
    if (existingUsers && existingUsers.length > 0) {
      userId = existingUsers[0].id;
      console.log("✅ User exists:", userId);
    } else {
      const { data: newUser, error } = await supabase
        .from("users")
        .insert({ name, mobile })
        .select()
        .single();

      if (error) {
        console.error("❌ User insert:", error);
        return res.status(500).json({ error: "User creation failed" });
      }

      userId = newUser.id;
      console.log("✅ New user:", userId);
    }

    const amount = quantity * ticketPrice;
    const orderId = "ORD_" + Date.now();

    // Create payment with mobile
    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .insert({
        order_id: orderId,
        amount,
        mobile: mobile, // ✅ FIX: Add mobile here
        status: "created",
        user_id: userId,
      })
      .select()
      .single();

    if (paymentError) {
      console.error("❌ Payment:", paymentError);
      return res.status(500).json({ error: "Payment creation failed" });
    }

    console.log("✅ Payment created:", payment);

    // Gateway order
    let order;
    try {
      order = await createGatewayOrder(orderId, amount, mobile, name);
    } catch (err) {
      await supabase.from("payments").delete().eq("order_id", orderId);
      return res.status(500).json({ error: err.message });
    }

    res.json({
      order_id: orderId,
      payment_url: order.payment_url,
      userId: userId,
      quantity: quantity,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  try {
    const { order_id, quantity, userId } = req.body;

    console.log("🔍 Verifying:", { order_id, quantity, userId });

    if (!order_id || !userId || !quantity) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check payment status from gateway
    const statusRes = await fetch(
      "https://upifastpe.com/api/check-order-status",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          user_token: process.env.GARUD_API_TOKEN,
          order_id,
        }),
      }
    );

    const statusData = await statusRes.json();
    console.log("📊 Gateway status:", statusData);

    if (statusData?.result?.status !== "SUCCESS") {
      return res.status(400).json({ error: "Payment not successful" });
    }

    // Check if tickets already generated
    const { data: existingTickets } = await supabase
      .from("tickets")
      .select("ticket_code")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(quantity);

    if (existingTickets && existingTickets.length >= quantity) {
      console.log("⚠️ Tickets already exist");
      return res.json({
        success: true,
        tickets: existingTickets.map((t) => t.ticket_code),
      });
    }

    // Generate new tickets
    const lotteryRound = await getCurrentLotteryRound();
    const codes = await generateUniqueTicketCodes(quantity, lotteryRound);

    console.log("🎫 Generated:", codes);

    // Insert tickets
    const ticketsToInsert = codes.map((code) => ({
      ticket_code: code,
      user_id: userId,
      status: "confirmed",
    }));

    const { data: insertedTickets, error: ticketError } = await supabase
      .from("tickets")
      .insert(ticketsToInsert)
      .select();

    if (ticketError) {
      console.error("❌ Ticket error:", ticketError);
      return res.status(500).json({
        error: "Ticket generation failed",
        details: ticketError.message,
      });
    }

    console.log("✅ Tickets inserted:", insertedTickets.length);

    // Update payment status
    const { error: updateError } = await supabase
      .from("payments")
      .update({ status: "success" })
      .eq("order_id", order_id);

    if (updateError) {
      console.error("⚠️ Payment update failed:", updateError);
    }

    res.json({ success: true, tickets: codes });
  } catch (err) {
    console.error("❌ Verify error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/result/:ticketCode", async (req, res) => {
  const { data } = await supabase
    .from("winners")
    .select("*")
    .eq("ticket_code", req.params.ticketCode.toUpperCase())
    .single();

  if (!data) return res.json({ won: false });
  res.json({ won: true, prize: data.prize_amount });
});

app.get("/api/recent-winners", async (req, res) => {
  try {
    const { data: winners } = await supabase
      .from("winners")
      .select("ticket_code, prize_amount")
      .order("prize_amount", { ascending: false })
      .limit(10);

    if (!winners || winners.length === 0) {
      return res.json({ success: true, winners: [] });
    }

    const ticketCodes = winners.map((w) => w.ticket_code);
    const { data: tickets } = await supabase
      .from("tickets")
      .select("ticket_code, user_id")
      .in("ticket_code", ticketCodes);

    const userIds = [...new Set(tickets.map((t) => t.user_id))];
    const { data: users } = await supabase
      .from("users")
      .select("id, name, mobile")
      .in("id", userIds);

    const winnersWithDetails = winners.map((winner) => {
      const ticket = tickets.find((t) => t.ticket_code === winner.ticket_code);
      const user = ticket ? users.find((u) => u.id === ticket.user_id) : null;

      return {
        ticket_code: winner.ticket_code,
        prize_amount: winner.prize_amount,
        name: user?.name || "Anonymous",
        mobile: user?.mobile
          ? `${user.mobile.substring(0, 3)}xxxxx${user.mobile.substring(8)}`
          : "Hidden",
      };
    });

    res.json({ success: true, winners: winnersWithDetails });
  } catch (err) {
    res.json({ success: true, winners: [] });
  }
});

// Admin endpoints
app.post("/api/admin/login", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid password" });
});

app.get("/api/admin/stats", async (req, res) => {
  const sold = await getSoldTicketsCount();
  const total = await getTotalTickets();
  res.json({ total, sold, remaining: total - sold });
});

app.get("/api/admin/settings", async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

app.post("/api/admin/settings", async (req, res) => {
  try {
    const {
      lottery_round,
      ticket_price,
      total_tickets,
      lottery_date,
      banner_image,
    } = req.body;

    const { data: current } = await supabase
      .from("lottery_settings")
      .select("*")
      .eq("is_active", true)
      .single();

    if (current) {
      await supabase
        .from("lottery_settings")
        .update({
          lottery_round: lottery_round || current.lottery_round,
          ticket_price: ticket_price || current.ticket_price,
          total_tickets: total_tickets || current.total_tickets,
          lottery_date: lottery_date || current.lottery_date,
          banner_image: banner_image || current.banner_image,
        })
        .eq("id", current.id);
    } else {
      await supabase.from("lottery_settings").insert({
        lottery_round: lottery_round || 1,
        ticket_price: ticket_price || 101,
        total_tickets: total_tickets || 1000,
        lottery_date,
        banner_image,
        is_active: true,
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/auto-generate-winners", async (req, res) => {
  try {
    const { count } = req.body;

    const { data: tickets } = await supabase
      .from("tickets")
      .select("ticket_code")
      .eq("status", "confirmed");

    if (!tickets || count > tickets.length) {
      return res.status(400).json({ error: "Not enough tickets" });
    }

    const shuffled = tickets.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, count);
    const prizes = [25000, 10000, 5000, 2000, 1000, 500];

    const winners = selected.map((t, i) => ({
      ticket_code: t.ticket_code,
      prize_amount: i < prizes.length ? prizes[i] : 500,
    }));

    for (const w of winners) {
      await supabase.from("winners").upsert(w);
    }

    res.json({ success: true, winners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/winners", async (req, res) => {
  const { winners } = req.body;
  for (const w of winners) {
    await supabase.from("winners").upsert({
      ticket_code: w.ticket_code.toUpperCase(),
      prize_amount: w.prize_amount,
    });
  }
  res.json({ success: true });
});

app.get("/api/admin/users", async (req, res) => {
  try {
    const { data: users } = await supabase
      .from("users")
      .select("*")
      .order("created_at", { ascending: false });

    const usersWithTickets = await Promise.all(
      users.map(async (user) => {
        const { data: tickets } = await supabase
          .from("tickets")
          .select("ticket_code")
          .eq("user_id", user.id);

        const ticketsWithWinner = await Promise.all(
          (tickets || []).map(async (ticket) => {
            const { data: winner } = await supabase
              .from("winners")
              .select("prize_amount")
              .eq("ticket_code", ticket.ticket_code)
              .single();

            return {
              ticket_code: ticket.ticket_code,
              is_winner: !!winner,
              prize_amount: winner?.prize_amount || 0,
            };
          })
        );

        return { ...user, tickets: ticketsWithWinner };
      })
    );

    res.json({ success: true, users: usersWithTickets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server: http://localhost:${PORT}`);
});
