import pino from "pino";
import { createApp } from "./app.js";

const logger = pino();
const port = Number(process.env.PORT ?? 8080);
const newspaperUrl = process.env.NEWSPAPER_URL ?? "http://newspaper.agents.svc.cluster.local";

createApp(newspaperUrl).listen(port, () => {
  logger.info({ port, newspaperUrl }, "service listening");
});
