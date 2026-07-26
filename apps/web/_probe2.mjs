import { apiKey } from "@better-auth/api-key";
const p = apiKey();
console.log("plugin id:", p.id);
console.log("endpoints:", Object.keys(p.endpoints || {}));
