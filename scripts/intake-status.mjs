import { localClient } from "./local-api.mjs";
const call = await localClient();
if (process.argv.includes("--resume")) await call("/admin/intake-resume", {});
console.log(JSON.stringify(await call("/admin/intake-status"), null, 2));
