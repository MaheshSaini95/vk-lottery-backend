import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";

dotenv.config();

const app = express();

// ✅ Updated CORS configuration
app.use(
  cors({
    origin: [
      "https://vk-lottery.netlify.app",
      "http://localhost:5500",
      "http://localhost:5501",
      "http://127.0.0.1:5500",
      "http://127.0.0.1:5501",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

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

// ============ HELPER FUNCTIONS ============

async function getSettings() {
  try {
    const { data, error } = await supabase
      .from("lottery_settings")
      .select("*")
      .eq("is_active", true)
      .order("id", { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Settings fetch error:", error);
    }

    return (
      data || {
        lottery_round: 1,
        ticket_price: 101,
        total_tickets: 1000,
        lottery_date: null,
        banner_image: null,
      }
    );
  } catch (err) {
    console.error("Error getting settings:", err);
    return {
      lottery_round: 1,
      ticket_price: 101,
      total_tickets: 1000,
      lottery_date: null,
      banner_image: null,
    };
  }
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

    const { data, error } = await supabase
      .from("tickets")
      .select("ticket_code")
      .eq("ticket_code", ticketCode)
      .single();

    if (error && error.code === "PGRST116") {
      codes.push(ticketCode);
    } else if (!data) {
      codes.push(ticketCode);
    }
  }

  if (codes.length < quantity) {
    throw new Error("Failed to generate unique ticket codes");
  }

  return codes;
}

// ✅ UPDATED: Payment Gateway Function with Better Error Handling
async function createGatewayOrder(orderId, amount, mobile, name) {
  try {
    console.log("📤 Gateway request:", { orderId, amount, mobile, name });

    const GATEWAY_URL = "https://upifastpe.com/api/create-order";

    const payload = new URLSearchParams();
    payload.append("customer_mobile", mobile);
    payload.append("user_token", process.env.GARUD_API_TOKEN);
    payload.append("amount", amount);
    payload.append("order_id", orderId);
    payload.append(
      "redirect_url",
      `${process.env.FRONTEND_SUCCESS_URL}/?order_id=${orderId}&status=success`
    );
    payload.append("remark1", name);
    payload.append("remark2", "lottery_ticket");

    console.log("📦 Sending to gateway...");
    console.log("🔗 Gateway URL:", GATEWAY_URL);
    console.log(
      "🔗 Redirect URL:",
      `${process.env.FRONTEND_SUCCESS_URL}/?order_id=${orderId}&status=success`
    );

    const response = await axios({
      method: "POST",
      url: GATEWAY_URL,
      data: payload.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
      timeout: 90000, // 90 seconds
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 600, // Accept all responses
    });

    const data = response.data;
    console.log("📥 Response status:", response.status);
    console.log("📥 Response data:", JSON.stringify(data, null, 2));

    // ✅ Check success conditions
    const isSuccess =
      data.status === "SUCCESS" ||
      data.status === "success" ||
      data.status === true ||
      data.msg === "Order Created Successfully" ||
      data.message === "Order Created Successfully" ||
      (data.payment_url && data.payment_url !== "") ||
      (data.result && data.result.payment_url);

    if (!isSuccess) {
      const errorMsg =
        data?.msg || data?.message || data?.error || "Gateway rejected order";
      console.error("❌ Gateway rejection:", errorMsg);
      throw new Error(errorMsg);
    }

    // ✅ Extract payment URL with multiple fallbacks
    const paymentUrl =
      data.payment_url ||
      data.link ||
      data.payment_link ||
      data.redirect_url ||
      data.url ||
      data.data?.payment_url ||
      data.data?.link ||
      data.result?.payment_url ||
      data.result?.link;

    if (!paymentUrl) {
      console.error("❌ No payment URL in response:", data);
      throw new Error("No payment URL received from gateway");
    }

    console.log("✅ Payment URL extracted:", paymentUrl);
    return { ...data, payment_url: paymentUrl };
  } catch (err) {
    console.error("❌ Gateway function error:", err.message);

    // ✅ Detailed error logging
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      console.error("❌ Timeout error - Gateway took too long to respond");
      throw new Error("Payment gateway timeout. Please try again in a moment.");
    } else if (err.code === "ENOTFOUND") {
      console.error("❌ DNS error - Cannot resolve gateway hostname");
      throw new Error("Payment gateway not reachable. Please contact support.");
    } else if (err.code === "ECONNREFUSED") {
      console.error("❌ Connection refused by gateway");
      throw new Error("Payment gateway refused connection. Please try again.");
    } else if (err.response) {
      console.error(
        "❌ Gateway HTTP error:",
        err.response.status,
        err.response.statusText
      );
      console.error("❌ Gateway error data:", err.response.data);
      throw new Error(
        `Gateway error: ${err.response.status} - ${err.response.statusText}`
      );
    }

    throw err;
  }
}

async function getSoldTicketsCount() {
  const { count, error } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true });

  if (error) {
    console.error("Error counting tickets:", error);
    return 0;
  }

  return count || 0;
}

// ============ API ROUTES ============

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    time: new Date().toISOString(),
    service: "VK Lottery Backend",
    version: "1.0.0",
  });
});

// Get remaining tickets
app.get("/api/tickets/remaining", async (req, res) => {
  try {
    const sold = await getSoldTicketsCount();
    const total = await getTotalTickets();
    res.json({ remaining: total - sold, sold, total });
  } catch (err) {
    console.error("❌ Remaining tickets error:", err);
    res.status(500).json({ error: "Failed to fetch remaining tickets" });
  }
});

// ✅ UPDATED: Create order with better error handling
app.post("/api/create-order", async (req, res) => {
  try {
    const { name, mobile, quantity } = req.body;

    console.log("📝 Create order request:", { name, mobile, quantity });

    // Validation
    if (!name || !mobile || !quantity) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: "Mobile number must be 10 digits" });
    }

    if (quantity < 1 || quantity > 100) {
      return res
        .status(400)
        .json({ error: "Quantity must be between 1 and 100" });
    }

    const ticketPrice = await getTicketPrice();
    const totalTickets = await getTotalTickets();
    const sold = await getSoldTicketsCount();
    const remaining = totalTickets - sold;

    if (remaining < quantity) {
      return res.status(400).json({
        error: `Only ${remaining} tickets remaining`,
        remaining,
      });
    }

    // Find or create user
    let { data: existingUsers, error: userQueryError } = await supabase
      .from("users")
      .select("*")
      .eq("mobile", mobile);

    if (userQueryError) {
      console.error("❌ User query error:", userQueryError);
      return res
        .status(500)
        .json({ error: "Database error while checking user" });
    }

    let userId;
    if (existingUsers && existingUsers.length > 0) {
      userId = existingUsers[0].id;
      console.log("✅ Existing user found:", userId);
    } else {
      const { data: newUser, error: insertError } = await supabase
        .from("users")
        .insert({ name, mobile })
        .select()
        .single();

      if (insertError) {
        console.error("❌ User insert error:", insertError);
        return res.status(500).json({ error: "Failed to create user account" });
      }

      userId = newUser.id;
      console.log("✅ New user created:", userId);
    }

    const amount = quantity * ticketPrice;
    const orderId = "ORD_" + Date.now();

    // Create payment record
    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .insert({
        order_id: orderId,
        amount,
        mobile: mobile,
        status: "created",
        user_id: userId,
      })
      .select()
      .single();

    if (paymentError) {
      console.error("❌ Payment insert error:", paymentError);
      return res.status(500).json({ error: "Failed to create payment record" });
    }

    console.log("✅ Payment record created:", payment);

    // ✅ Create gateway order with error handling
    let order;
    try {
      order = await createGatewayOrder(orderId, amount, mobile, name);
    } catch (gatewayError) {
      console.error("❌ Gateway order creation failed:", gatewayError.message);

      // Clean up failed payment record
      await supabase.from("payments").delete().eq("order_id", orderId);

      return res.status(500).json({
        error:
          gatewayError.message || "Payment gateway error. Please try again.",
      });
    }

    res.json({
      order_id: orderId,
      payment_url: order.payment_url,
      userId: userId,
      quantity: quantity,
      amount: amount,
    });
  } catch (err) {
    console.error("❌ Create order error:", err);
    res.status(500).json({ error: err.message || "Failed to create order" });
  }
});

// ✅ UPDATED: Verify payment with axios
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { order_id, quantity, userId } = req.body;

    console.log("🔍 Verifying payment:", { order_id, quantity, userId });

    if (!order_id || !userId || !quantity) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check payment status from gateway using axios
    const statusRes = await axios({
      method: "POST",
      url: "https://upifastpe.com/api/check-order-status",
      data: new URLSearchParams({
        user_token: process.env.GARUD_API_TOKEN,
        order_id: order_id,
      }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 30000,
    });

    const statusData = statusRes.data;
    console.log("📊 Payment status response:", statusData);

    if (statusData?.result?.status !== "SUCCESS") {
      return res.status(400).json({ error: "Payment not successful yet" });
    }

    // Check if tickets already generated
    const { data: existingTickets } = await supabase
      .from("tickets")
      .select("ticket_code")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(quantity);

    const { data: payment } = await supabase
      .from("payments")
      .select("status")
      .eq("order_id", order_id)
      .single();

    if (
      payment?.status === "success" &&
      existingTickets &&
      existingTickets.length >= quantity
    ) {
      console.log("⚠️ Tickets already generated for this order");
      return res.json({
        success: true,
        tickets: existingTickets.map((t) => t.ticket_code),
      });
    }

    // Generate new tickets
    const lotteryRound = await getCurrentLotteryRound();
    const codes = await generateUniqueTicketCodes(quantity, lotteryRound);

    console.log("🎫 Generated ticket codes:", codes);

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
      console.error("❌ Ticket insertion error:", ticketError);
      return res.status(500).json({
        error: "Failed to generate tickets",
        details: ticketError.message,
      });
    }

    console.log("✅ Tickets inserted successfully:", insertedTickets.length);

    // Update payment status
    const { error: updateError } = await supabase
      .from("payments")
      .update({ status: "success" })
      .eq("order_id", order_id);

    if (updateError) {
      console.error("⚠️ Payment status update failed:", updateError);
    }

    res.json({ success: true, tickets: codes });
  } catch (err) {
    console.error("❌ Verify payment error:", err);
    res
      .status(500)
      .json({ error: err.message || "Payment verification failed" });
  }
});

// Check result
app.get("/api/result/:ticketCode", async (req, res) => {
  try {
    const code = req.params.ticketCode.toUpperCase();

    const { data, error } = await supabase
      .from("winners")
      .select("*")
      .eq("ticket_code", code)
      .maybeSingle();

    if (error) {
      console.error("Result check error:", error);
      return res.status(500).json({ error: "Failed to check result" });
    }

    if (!data) {
      return res.json({ won: false });
    }

    res.json({ won: true, prize: data.prize_amount });
  } catch (err) {
    res.status(500).json({ error: "Result check failed" });
  }
});

// Get recent winners
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
    console.error("Recent winners error:", err);
    res.json({ success: true, winners: [] });
  }
});

// ============ ADMIN ENDPOINTS ============

// Admin login
app.post("/api/admin/login", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid password" });
});

// Admin stats
app.get("/api/admin/stats", async (req, res) => {
  try {
    const sold = await getSoldTicketsCount();
    const total = await getTotalTickets();
    res.json({ total, sold, remaining: total - sold });
  } catch (err) {
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// Get settings
app.get("/api/admin/settings", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to get settings" });
  }
});

// Update settings
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

// Auto-generate winners
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

// Manual winners
app.post("/api/admin/winners", async (req, res) => {
  try {
    const { winners } = req.body;

    for (const w of winners) {
      await supabase.from("winners").upsert({
        ticket_code: w.ticket_code.toUpperCase(),
        prize_amount: w.prize_amount,
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get users with tickets
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

// ============ SERVER START ============

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/`);
  console.log(`📡 API base: http://localhost:${PORT}/api`);
});
