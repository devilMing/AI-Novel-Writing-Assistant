import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { authMiddleware } from "../../../../middleware/auth";
import { chatGPTAuthService } from "../application/ChatGPTAuthService";

const router = Router();

router.get("/settings/chatgpt/callback", async (req, res) => {
  try {
    await chatGPTAuthService.completeCallback({
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      code: typeof req.query.code === "string" ? req.query.code : undefined,
      clientId: typeof req.query.client_id === "string" ? req.query.client_id : undefined,
      error: typeof req.query.error === "string" ? req.query.error : undefined,
    });
    res.status(200).type("html").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权完成</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>ChatGPT 授权完成</h1><p>可以关闭此页面并返回应用。</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ChatGPT 授权失败。";
    res.status(400).type("html").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权失败</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>ChatGPT 授权失败</h1><p>${message.replace(/[&<>"']/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!)}</p><p>请关闭此页面并返回应用重试。</p></body></html>`);
  }
});

router.use(authMiddleware);

router.post("/settings/chatgpt/start", async (req, res, next) => {
  try {
    const port = req.socket.localPort;
    const redirectUri = `http://127.0.0.1:${port}/api/settings/chatgpt/callback`;
    const data = await chatGPTAuthService.start({ redirectUri });
    res.status(200).json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/settings/chatgpt/status", async (_req, res, next) => {
  try {
    const data = await chatGPTAuthService.status();
    res.status(200).json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.delete("/settings/chatgpt/session", async (_req, res, next) => {
  try {
    await chatGPTAuthService.disconnect();
    res.status(200).json({ success: true, data: null, message: "已断开 ChatGPT 网页授权。" } satisfies ApiResponse<null>);
  } catch (error) {
    next(error);
  }
});

export default router;
