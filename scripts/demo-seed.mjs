import { localClient } from "./local-api.mjs";
const call = await localClient();
await call("/admin/demo", {});
console.log("架空のデモ資料をローカルへ登録しました。");
