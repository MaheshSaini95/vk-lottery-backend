import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Config
const TOTAL_TICKETS = 1000;
const TICKET_PRICE = 101;

// ================== HELPER: Get Current Lottery Round ==================
async function getCurrentLotteryRound() {
  try {
    const { data, error } = await supabase
      .from("lottery_settings")
      .select("lottery_round")
      .eq("is_active", true)
      .order("id", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      console.log("No lottery settings found, using default round 1");
      return 1;
    }

    return data.lottery_round || 1;
  } catch (err) {
    console.error("Error getting lottery round:", err);
    return 1;
  }
}

// ================== HELPER: Generate Random Code ==================
function generateRandomCode(length = 5) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ================== HELPER: Generate Unique Ticket Codes ==================
async function generateUniqueTicketCodes(quantity, lotteryRound) {
  const codes = [];
  const maxAttempts = quantity * 10; // Prevent infinite loop
  let attempts = 0;

  while (codes.length < quantity && attempts < maxAttempts) {
    attempts++;

    // Generate code format: 1LOT-ABC123 (Round + LOT + Random)
    const randomPart = generateRandomCode(5);
    const ticketCode = `${lotteryRound}LOT-${randomPart}`;

    // Check if code already exists in database
    const { data: existingTicket } = await supabase
      .from("tickets")
      .select("ticket_code")
      .eq("ticket_code", ticketCode)
      .single();

    // If code doesn't exist, add it
    if (!existingTicket) {
      codes.push(ticketCode);
    }
  }

  if (codes.length < quantity) {
    throw new Error("Failed to generate unique ticket codes");
  }

  return codes;
}

// ================== CASHFREE HELPER ==================
async function cashfreeRequest(path, method, body) {
  const baseUrl =
    process.env.CASHFREE_ENV === "test"
      ? "https://sandbox.cashfree.com"
      : "https://api.cashfree.com";

  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-client-id": process.env.CASHFREE_CLIENT_ID,
      "x-client-secret": process.env.CASHFREE_CLIENT_SECRET,
      "x-api-version": "2023-08-01",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || "Cashfree API error");
  }
  return data;
}

// ================== HELPERS ==================
async function getSoldTicketsCount() {
  const { count, error } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count || 0;
}

// ================== REMAINING TICKETS ==================
app.get("/api/tickets/remaining", async (req, res) => {
  try {
    const sold = await getSoldTicketsCount();
    res.json({ remaining: TOTAL_TICKETS - sold });
  } catch {
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// ================== CREATE ORDER ==================
app.post("/api/create-order", async (req, res) => {
  try {
    const { name, mobile, quantity } = req.body;

    if (!name || !mobile || !quantity || quantity <= 0) {
      return res.status(400).json({ error: "Invalid input" });
    }

    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: "Mobile must be 10 digits" });
    }

    const sold = await getSoldTicketsCount();
    const remaining = TOTAL_TICKETS - sold;

    if (remaining < quantity) {
      return res.status(400).json({ error: "Not enough tickets left" });
    }

    // Get current lottery round
    const lotteryRound = await getCurrentLotteryRound();

    // User upsert
    let { data: users } = await supabase
      .from("users")
      .select("*")
      .eq("mobile", mobile)
      .limit(1);

    let userId;
    if (users && users.length > 0) {
      userId = users[0].id;
      await supabase.from("users").update({ name }).eq("id", userId);
    } else {
      const { data: newUser, error } = await supabase
        .from("users")
        .insert({ name, mobile })
        .select()
        .single();
      if (error) throw error;
      userId = newUser.id;
    }

    // Create Cashfree order
    const orderId = "ORD_" + Date.now();
    const amount = quantity * TICKET_PRICE;

    const order = await cashfreeRequest("/pg/orders", "POST", {
      order_id: orderId,
      order_amount: amount,
      order_currency: "INR",
      customer_details: {
        customer_id: String(userId),
        customer_name: name,
        customer_phone: mobile,
      },
    });

    await supabase.from("payments").insert({
      order_id: orderId,
      amount,
      status: "created",
      user_id: userId,
    });

    res.json({
      order_id: orderId,
      payment_session_id: order.payment_session_id,
      userId,
      quantity,
      lottery_round: lotteryRound,
    });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== VERIFY PAYMENT ==================
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { order_id, userId, quantity } = req.body;

    console.log("🔍 Verifying payment for order:", order_id);

    let order;
    let attempts = 0;

    // Retry loop
    while (attempts < 5) {
      console.log(`⏳ Attempt ${attempts + 1}/5 - Checking order status...`);

      order = await cashfreeRequest(`/pg/orders/${order_id}`, "GET");
      console.log(`📊 Order status: ${order.order_status}`);

      if (order.order_status === "PAID") {
        console.log("✅ Payment confirmed!");
        break;
      }

      attempts++;
      if (attempts < 5) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (order.order_status !== "PAID") {
      console.log("❌ Payment not confirmed after 5 attempts");
      return res.status(400).json({ error: "Payment not confirmed yet" });
    }

    // Get current lottery round
    const lotteryRound = await getCurrentLotteryRound();

    // Generate unique ticket codes
    console.log(
      `🎫 Generating ${quantity} unique tickets for Round ${lotteryRound}`
    );

    const codes = await generateUniqueTicketCodes(quantity, lotteryRound);
    console.log("🎟️ Generated ticket codes:", codes);

    const rows = codes.map((code) => ({
      ticket_code: code,
      user_id: userId,
      status: "confirmed",
    }));

    const { error: insertError } = await supabase.from("tickets").insert(rows);
    if (insertError) {
      console.error("❌ Failed to insert tickets:", insertError);
      throw insertError;
    }

    console.log("✅ Tickets saved to database");

    await supabase
      .from("payments")
      .update({ status: "success" })
      .eq("order_id", order_id);

    console.log("✅ Payment marked as success");

    res.json({ success: true, tickets: codes });
  } catch (err) {
    console.error("❌ Verify payment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== CASHFREE WEBHOOK ==================
app.post("/api/cashfree/webhook", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || payload.type !== "PAYMENT_SUCCESS") {
      return res.status(200).send("Ignored");
    }

    const orderId = payload.data.order.order_id;

    const { data: payment } = await supabase
      .from("payments")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle();

    if (!payment || payment.status === "success") {
      return res.status(200).send("Already processed");
    }

    await supabase
      .from("payments")
      .update({ status: "success" })
      .eq("order_id", orderId);

    const { data: orderRow } = await supabase
      .from("payments")
      .select("user_id, amount")
      .eq("order_id", orderId)
      .single();

    const quantity = Math.round(orderRow.amount / TICKET_PRICE);
    const lotteryRound = await getCurrentLotteryRound();

    const ticketCodes = await generateUniqueTicketCodes(quantity, lotteryRound);

    const rows = ticketCodes.map((code) => ({
      ticket_code: code,
      user_id: orderRow.user_id,
      status: "confirmed",
    }));

    await supabase.from("tickets").insert(rows);

    console.log("🎟 Tickets generated via webhook:", ticketCodes);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).send("Webhook failed");
  }
});

// ================== CHECK RESULT ==================
app.get("/api/result/:ticketCode", async (req, res) => {
  try {
    const code = req.params.ticketCode.toUpperCase();
    const { data } = await supabase
      .from("winners")
      .select("*")
      .eq("ticket_code", code)
      .maybeSingle();

    if (!data) return res.json({ won: false });

    res.json({ won: true, prize: data.prize_amount });
  } catch {
    res.status(500).json({ error: "Result check failed" });
  }
});

// ================== GET RECENT WINNERS ==================
app.get("/api/recent-winners", async (req, res) => {
  try {
    const { data: winners, error: winnersError } = await supabase
      .from("winners")
      .select("ticket_code, prize_amount")
      .order("prize_amount", { ascending: false })
      .limit(10);

    if (winnersError) {
      console.error("Winners error:", winnersError);
      return res.json({ success: true, winners: [] });
    }

    if (!winners || winners.length === 0) {
      return res.json({ success: true, winners: [] });
    }

    const ticketCodes = winners.map((w) => w.ticket_code);

    const { data: tickets, error: ticketsError } = await supabase
      .from("tickets")
      .select("ticket_code, user_id")
      .in("ticket_code", ticketCodes);

    if (ticketsError) {
      console.error("Tickets error:", ticketsError);
      return res.json({ success: true, winners: [] });
    }

    const userIds = [...new Set(tickets.map((t) => t.user_id))];

    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, name, mobile")
      .in("id", userIds);

    if (usersError) {
      console.error("Users error:", usersError);
      return res.json({ success: true, winners: [] });
    }

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
    console.error("Recent winners error:", err);
    res.json({ success: true, winners: [] });
  }
});

// ================== ADMIN ==================
app.post("/api/admin/login", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid password" });
});

app.get("/api/admin/stats", async (req, res) => {
  const sold = await getSoldTicketsCount();
  res.json({
    total: TOTAL_TICKETS,
    sold,
    remaining: TOTAL_TICKETS - sold,
  });
});

// ================== ADMIN: GET SETTINGS ==================
app.get("/api/admin/settings", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("lottery_settings")
      .select("*")
      .eq("is_active", true)
      .order("id", { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    if (!data) {
      // Return default settings
      return res.json({
        lottery_round: 1,
        ticket_price: 101,
        total_tickets: 1000,
        lottery_date: null,
        banner_image: null,
      });
    }

    res.json(data);
  } catch (err) {
    console.error("Get settings error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== ADMIN: SAVE SETTINGS ==================
app.post("/api/admin/settings", async (req, res) => {
  try {
    const {
      lottery_round,
      ticket_price,
      total_tickets,
      lottery_date,
      banner_image,
    } = req.body;

    // Get current settings
    const { data: currentSettings } = await supabase
      .from("lottery_settings")
      .select("*")
      .eq("is_active", true)
      .single();

    if (currentSettings) {
      // Update existing settings
      const { error } = await supabase
        .from("lottery_settings")
        .update({
          lottery_round: lottery_round || currentSettings.lottery_round,
          ticket_price: ticket_price || currentSettings.ticket_price,
          total_tickets: total_tickets || currentSettings.total_tickets,
          lottery_date: lottery_date || currentSettings.lottery_date,
          banner_image: banner_image || currentSettings.banner_image,
          updated_at: new Date().toISOString(),
        })
        .eq("id", currentSettings.id);

      if (error) throw error;
    } else {
      // Insert new settings
      const { error } = await supabase.from("lottery_settings").insert({
        lottery_round: lottery_round || 1,
        ticket_price: ticket_price || 101,
        total_tickets: total_tickets || 1000,
        lottery_date,
        banner_image,
        is_active: true,
      });

      if (error) throw error;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Save settings error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== ADMIN: AUTO GENERATE WINNERS ==================
app.post("/api/admin/auto-generate-winners", async (req, res) => {
  try {
    const { count } = req.body;

    if (!count || count < 1 || count > 50) {
      return res.status(400).json({ error: "Count must be between 1 and 50" });
    }

    const { data: tickets, error } = await supabase
      .from("tickets")
      .select("ticket_code")
      .eq("status", "confirmed");

    if (error) throw error;

    if (!tickets || tickets.length === 0) {
      return res.status(400).json({ error: "No tickets sold yet" });
    }

    if (count > tickets.length) {
      return res.status(400).json({
        error: `Cannot generate ${count} winners. Only ${tickets.length} tickets sold.`,
      });
    }

    const shuffled = tickets.sort(() => 0.5 - Math.random());
    const selectedTickets = shuffled.slice(0, count);

    const prizes = [25000, 10000, 5000, 2000, 1000, 500];

    const winners = selectedTickets.map((ticket, index) => {
      let prize;
      if (index < prizes.length) {
        prize = prizes[index];
      } else {
        prize = 500;
      }

      return {
        ticket_code: ticket.ticket_code,
        prize_amount: prize,
      };
    });

    for (const w of winners) {
      await supabase.from("winners").upsert({
        ticket_code: w.ticket_code,
        prize_amount: w.prize_amount,
      });
    }

    res.json({ success: true, winners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== ADMIN: MANUAL WINNERS ==================
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

// ================== ADMIN: GET USERS ==================
app.get("/api/admin/users", async (req, res) => {
  try {
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("*")
      .order("created_at", { ascending: false });

    if (usersError) throw usersError;

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

        return {
          ...user,
          tickets: ticketsWithWinner,
        };
      })
    );

    res.json({ success: true, users: usersWithTickets });
  } catch (err) {
    console.error("Get users error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== START SERVER ==================
app.listen(process.env.PORT || 4000, () => {
  console.log("Server running on port", process.env.PORT || 4000);
});
