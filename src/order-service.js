const express = require("express");
const { Pool } = require("pg");
const client = require("prom-client");

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

app.post("/orders", async (req, res) => {
  const { product_id, quantity, requested_by } = req.body;
  if (!product_id || !quantity) return res.status(400).json({ error: "product_id and quantity are required" });
  const result = await pool.query(
    "INSERT INTO supply_orders (product_id, quantity, requested_by) VALUES ($1, $2, $3) RETURNING *",
    [product_id, quantity, requested_by || null]
  );
  res.status(201).json(result.rows[0]);
});

app.get("/orders", async (_req, res) => {
  const result = await pool.query("SELECT * FROM supply_orders ORDER BY id");
  res.json(result.rows);
});

app.patch("/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ["created", "approved", "rejected", "fulfilled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "invalid status" });
  const result = await pool.query(
    "UPDATE supply_orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
    [status, id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "order not found" });
  res.json(result.rows[0]);
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`order-service running on ${PORT}`)))
  .catch((e) => {
    console.error("DB init failed", e);
    process.exit(1);
  });
