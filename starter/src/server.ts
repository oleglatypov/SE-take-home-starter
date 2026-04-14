import express from "express";
import { trialsRouter } from "./routes/trials.js";

const app = express();
app.use(express.json());

app.use("/trials", trialsRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: message });
});

const PORT = process.env["PORT"] ?? 3000;

if (process.env["VITEST"] !== "true") {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export { app };
