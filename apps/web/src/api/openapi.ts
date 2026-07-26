// OpenAPI ドキュメントの閲覧 UI。
// 仕様そのもの (/api/openapi) は handler.ts 側で openAPIRouteHandler が生やす。

import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";

const openAPIRouter = new Hono();

openAPIRouter.get("/scalar", Scalar({ url: "/api/openapi" }));

export default openAPIRouter;
