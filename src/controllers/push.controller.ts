import type { Request, Response } from "express";
import { pushService as svc } from "../services/push";
import type { PushOwner } from "../services/push/store";
import { asyncHandler } from "../utils/asyncHandler";
import { sendMessage, sendSuccess } from "../utils/response";

/**
 * Push endpoints shared by the student, lecturer and HOD APIs. Each API passes its OWN way of reading the authenticated identity
 * (set by that API's existing auth middleware): the owner is never taken from the request body, query or params.
 */
export function pushController(identify: (req: Request) => PushOwner) {
  const H = (fn: (req: Request, res: Response, me: PushOwner) => Promise<unknown>) => asyncHandler(async (req, res) => void (await fn(req, res, identify(req))));
  return {
    config: H(async (_req, res) => sendSuccess(res, svc.publicConfig())),
    subscribe: H(async (req, res, me) => sendSuccess(res, await svc.register(me, { ...req.body.subscription, deviceLabel: req.body.deviceLabel }, req.get("user-agent") ?? undefined), "Notifications enabled on this device.", 201)),
    unsubscribe: H(async (req, res, me) => sendSuccess(res, await svc.unregister(me, req.body.endpoint), "Notifications turned off on this device.")),
    devices: H(async (_req, res, me) => sendSuccess(res, await svc.listDevices(me))),
    removeDevice: H(async (req, res, me) => { await svc.unregisterById(me, req.params.id); sendMessage(res, "Device removed."); }),
    preferences: H(async (_req, res, me) => sendSuccess(res, await svc.getPreferences(me))),
    updatePreferences: H(async (req, res, me) => sendSuccess(res, await svc.setPreferences(me, req.body), "Notification preferences saved.")),
    test: H(async (_req, res, me) => sendSuccess(res, await svc.sendTest(me), "Test notification sent.")),
  };
}
