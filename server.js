import { createApp } from "./lib/app.js";

const port = Number(process.env.PORT || 3024);
const app = createApp();
const actualPort = await app.start(port);
console.log(`Racing pigeon registry app listening on http://localhost:${actualPort}`);
