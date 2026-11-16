import "dotenv/config";
import { pathToFileURL } from "node:url";
import User from "./models/user.js";
import express from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import cors from "cors";

// =====================================================
// ROUTERS
// =====================================================

import userRouter from "./routes/userRouter.js";
import productRouter from "./routes/productRouter.js";
import orderRouter from "./routes/orderRouter.js";
import cartRouter from "./routes/cartRouter.js";
import customOrderRouter from "./routes/customOrderRouter.js";
import measurementRouter from "./routes/measurementRouter.js";
import adminUserRouter from "./routes/adminUserRouter.js";
import dashboardRouter from "./routes/dashboardRouter.js";
import paymentRouter from "./routes/paymentRouter.js";
import { paymentsLkWebhook } from "./controller/paymentController.js";
import dns from "node:dns";

dns.setServers(["1.1.1.1", "8.8.8.8"]);

// =====================================================
// ENVIRONMENT VARIABLES
// =====================================================

// =====================================================
// REQUIRED ENV CHECK
// =====================================================

if (!process.env.MONGO_URI) {
  throw new Error("MONGO_URI is missing from environment variables");
}

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is missing from environment variables");
}

if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}

// =====================================================
// EXPRESS APP
// =====================================================

const app = express();

// =====================================================
// RENDER / PROXY
// =====================================================

// Render runs the app behind a reverse proxy.
// Useful for correct IP / HTTPS information later.
app.set("trust proxy", 1);

// =====================================================
// CORS
// =====================================================
//
// Example:
// CORS_ORIGINS=http://localhost:5173,https://naricraft.com
//
// If CORS_ORIGINS is not set,
// FRONTEND_URL will be used.
//

const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  process.env.FRONTEND_URL ||
  "http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // -------------------------------------------------
      // No Origin header:
      //
      // Allow server-to-server requests such as
      // signed payment webhooks,
      // Postman, curl, etc.
      // -------------------------------------------------

      if (!origin) {
        callback(null, true);

        return;
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");

      if (allowedOrigins.includes(normalizedOrigin)) {
        callback(null, true);

        return;
      }

      callback(new Error("Not allowed by CORS"));
    },

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// =====================================================
// PAYMENTS.LK WEBHOOK
//
// IMPORTANT:
// This route MUST be mounted before express.json().
// Payments.lk signs the exact raw JSON bytes.
// =====================================================

app.post(
  "/api/payments/payments-lk/webhook",
  express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  paymentsLkWebhook,
);

// =====================================================
// BODY PARSERS
// =====================================================

// Normal React / JSON API requests
app.use(
  express.json({
    limit: "2mb",
  }),
);

// Optional form-encoded request support.
// Normal React requests use JSON.
app.use(
  express.urlencoded({
    extended: false,
    limit: "2mb",
  }),
);

// =====================================================
// HEALTH CHECK
// =====================================================
//
// Useful for Render and browser testing.
//
// GET:
// https://YOUR-BACKEND.onrender.com/health
//

app.get("/health", (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;

  res.status(mongoConnected ? 200 : 503).json({
    status: mongoConnected ? "ok" : "unavailable",

    service: "NariCraft API",

    database: mongoConnected ? "connected" : "connecting",
  });
});

// =====================================================
// ROOT
// =====================================================

app.get("/", (req, res) => {
  res.status(200).json({
    message: "NariCraft Backend API is running",
  });
});

// =====================================================
// AUTH MIDDLEWARE
//
// Token exists:
// verify token and attach decoded user to req.user.
//
// No token:
// continue.
//
// This is important because public endpoints
// such as signed payment webhooks do NOT send our JWT.
// =====================================================

app.use(async (req, res, next) => {
  let token = req.header("Authorization");

  // =========================================
  // NO TOKEN
  // =========================================

  if (!token) {
    next();

    return;
  }

  // =========================================
  // BEARER TOKEN
  // =========================================

  token = token.replace(/^Bearer\s+/i, "");

  if (!token) {
    res.status(401).json({
      message: "Invalid authorization token",
    });

    return;
  }

  // =========================================
  // VERIFY
  // =========================================

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
  try {
    const currentUser = await User.findOne({ email: decoded.email }).select(
      "-password",
    );
    if (!currentUser || currentUser.isBlocked) {
      return res
        .status(403)
        .json({ message: "Account is unavailable or blocked" });
    }
    req.user = currentUser.toObject();

    next();
  } catch (err) {
    console.error("Authentication database lookup failed:", err.message);
    res
      .status(503)
      .json({ message: "Account service is temporarily unavailable" });
  }
});

// =====================================================
// API ROUTES
// =====================================================

app.use("/api", (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res
      .status(503)
      .json({ message: "Database is unavailable. Please try again shortly." });
  }
  next();
});

app.use("/api/users", userRouter);

app.use("/api/products", productRouter);

app.use("/api/orders", orderRouter);

app.use("/api/cart", cartRouter);

app.use("/api/custom-orders", customOrderRouter);

app.use("/api/measurements", measurementRouter);

app.use("/api/admin/users", adminUserRouter);

app.use("/api/admin/dashboard", dashboardRouter);

app.use("/api/payments", paymentRouter);

// =====================================================
// 404
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    message: "API route not found",
  });
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((err, req, res, next) => {
  // =========================================
  // CORS
  // =========================================

  if (err.message === "Not allowed by CORS") {
    res.status(403).json({
      message: "Origin not allowed",
    });

    return;
  }

  // =========================================
  // OTHER ERRORS
  // =========================================

  console.error("Unhandled Server Error:", err.message);

  const status =
    err.type === "entity.parse.failed"
      ? 400
      : err.type === "entity.too.large"
        ? 413
        : 500;
  res
    .status(status)
    .json({
      message:
        status === 400
          ? "Invalid JSON body"
          : status === 413
            ? "Request body is too large"
            : "Internal server error",
    });
});

// =====================================================
// SERVER
// =====================================================
//
// Local:
// PORT falls back to 5000.
//
// Render:
// Render supplies process.env.PORT.
//

export { app };

export async function startServer() {
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  const server = app.listen(Number(process.env.PORT) || 5000, "0.0.0.0", () =>
    console.log("NariCraft API ready"),
  );
  const shutdown = () =>
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer().catch((error) => {
    console.error("Startup failed:", error.message);
    process.exitCode = 1;
  });
}
