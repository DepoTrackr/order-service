const express = require("express");
const { Pool } = require("pg");
const client = require("prom-client");
const { requireAuth, requireMinRole } = require("./lib/jwt");
const { ALLOWED_STATUSES, STATUS_TRANSITIONS } = require("./lib/transitions");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3003;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpCounter = new client.Counter({
  name: "order_http_requests_total",
  help: "Total HTTP requests on order service",
  labelNames: ["route", "method", "status"],
});
register.registerMetric(httpCounter);
app.use((req, res, next) => {
  res.on("finish", () => httpCounter.inc({ route: req.path, method: req.method, status: res.statusCode }));
  next();
});

const sendError = (res, status, code, message) => res.status(status).json({ error: message, code });

const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_orders (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'created',
      requested_by VARCHAR(120),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
};

app.get("/health", (_req, res) => res.json({ status: "ok", service: "order" }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use(requireAuth);

app.post("/orders", requireMinRole("manager"), async (req, res) => {
  const { product_id, quantity, requested_by } = req.body;
  if (!product_id || !quantity) return sendError(res, 400, "VALIDATION_ERROR", "product_id and quantity are required");
  if (quantity <= 0) return sendError(res, 400, "VALIDATION_ERROR", "quantity must be positive");

  const clientDb = await pool.connect();
  try {
    await clientDb.query("BEGIN");
    const product = await clientDb.query("SELECT id, stock, name FROM products WHERE id=$1 FOR UPDATE", [product_id]);
    if (!product.rows[0]) {
      await clientDb.query("ROLLBACK");
      return sendError(res, 404, "PRODUCT_NOT_FOUND", "product not found");
    }
    if (product.rows[0].stock < quantity) {
      await clientDb.query("ROLLBACK");
      return sendError(res, 409, "INSUFFICIENT_STOCK", `insufficient stock for ${product.rows[0].name}`);
    }
    const result = await clientDb.query(
      "INSERT INTO supply_orders (product_id, quantity, requested_by) VALUES ($1, $2, $3) RETURNING *",
      [product_id, quantity, requested_by || req.user.username]
    );
    await clientDb.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await clientDb.query("ROLLBACK");
    if (err.code === "42P01") return sendError(res, 503, "CATALOG_UNAVAILABLE", "products table not available");
    return sendError(res, 500, "INTERNAL_ERROR", "internal error");
  } finally {
    clientDb.release();
  }
});

app.get("/orders", requireMinRole("viewer"), async (_req, res) => {
  const result = await pool.query(`
    SELECT o.*, p.name AS product_name, p.stock AS product_stock
    FROM supply_orders o
    LEFT JOIN products p ON p.id = o.product_id
    ORDER BY o.id
  `);
  res.json(result.rows);
});

app.get("/orders/:id", requireMinRole("viewer"), async (req, res) => {
  const result = await pool.query(
    `
    SELECT o.*, p.name AS product_name, p.stock AS product_stock
    FROM supply_orders o
    LEFT JOIN products p ON p.id = o.product_id
    WHERE o.id=$1
  `,
    [req.params.id]
  );
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "order not found");
  res.json(result.rows[0]);
});

app.patch("/orders/:id/status", requireMinRole("manager"), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!ALLOWED_STATUSES.includes(status)) {
    return sendError(res, 400, "VALIDATION_ERROR", `status must be one of: ${ALLOWED_STATUSES.join(", ")}`);
  }

  const clientDb = await pool.connect();
  try {
    await clientDb.query("BEGIN");
    const orderResult = await clientDb.query("SELECT * FROM supply_orders WHERE id=$1 FOR UPDATE", [id]);
    const order = orderResult.rows[0];
    if (!order) {
      await clientDb.query("ROLLBACK");
      return sendError(res, 404, "NOT_FOUND", "order not found");
    }
    const nextStatuses = STATUS_TRANSITIONS[order.status] || [];
    if (!nextStatuses.includes(status)) {
      await clientDb.query("ROLLBACK");
      return sendError(res, 409, "INVALID_TRANSITION", `cannot transition from ${order.status} to ${status}`);
    }

    if (status === "fulfilled") {
      const product = await clientDb.query("SELECT id, stock, name FROM products WHERE id=$1 FOR UPDATE", [
        order.product_id,
      ]);
      if (!product.rows[0]) {
        await clientDb.query("ROLLBACK");
        return sendError(res, 404, "PRODUCT_NOT_FOUND", "product not found");
      }
      if (product.rows[0].stock < order.quantity) {
        await clientDb.query("ROLLBACK");
        return sendError(res, 409, "INSUFFICIENT_STOCK", `insufficient stock for ${product.rows[0].name}`);
      }
      await clientDb.query("UPDATE products SET stock = stock - $1 WHERE id=$2", [order.quantity, order.product_id]);
    }

    const updated = await clientDb.query(
      "UPDATE supply_orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [status, id]
    );
    await clientDb.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await clientDb.query("ROLLBACK");
    if (err.code === "42P01") return sendError(res, 503, "CATALOG_UNAVAILABLE", "products table not available");
    return sendError(res, 500, "INTERNAL_ERROR", "internal error");
  } finally {
    clientDb.release();
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`order-service running on ${PORT}`)))
  .catch((e) => {
    console.error("DB init failed", e);
    process.exit(1);
  });

module.exports = app;
