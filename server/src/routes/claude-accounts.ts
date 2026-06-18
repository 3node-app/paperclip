// Read-only routes that surface the multi-account Claude credentials store
// (packages/adapters/claude-local/src/server/multi-account.ts) so the UI can
// show which accounts are connected and where each one's `.credentials.json`
// must live for the operator to drop OAuth credentials into via SSH.

import { Router, type Request } from "express";
import { z } from "zod";
import {
  createDefaultMultiAccountStore,
  type AccountSummary,
} from "@paperclipai/adapter-claude-local/server";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertBoardOrgAccess } from "./authz.js";

function assertCanManageClaudeAccounts(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

const createAccountSchema = z.object({
  body: z.object({
    label: z.string().min(1).max(80),
  }),
});

export function claudeAccountsRoutes() {
  const router = Router();
  const store = createDefaultMultiAccountStore();

  router.get("/instance/claude-accounts", async (req, res) => {
    assertBoardOrgAccess(req);
    const accounts: AccountSummary[] = await store.list();
    res.json({
      accounts: accounts.map((account) => ({
        id: account.id,
        label: account.label,
        isActive: account.isActive,
        isExhausted: account.isExhausted,
        percentUsed: account.percentUsed,
        hasCredentials: account.hasCredentials,
        createdAt: account.createdAt,
        credentialsPath: store.credentialsFile(account.id),
      })),
    });
  });

  router.post(
    "/instance/claude-accounts",
    validate(createAccountSchema),
    async (req, res) => {
      assertCanManageClaudeAccounts(req);
      const id = await store.createAccount(req.body.label);
      res.status(201).json({
        id,
        label: req.body.label,
        credentialsPath: store.credentialsFile(id),
        loginInstructions:
          `Run inside the paperclip container: ` +
          `\`CLAUDE_CONFIG_DIR=${store.accountDir(id)} claude /login\`. ` +
          `Authorize the OAuth flow in your browser, then this account will ` +
          `appear as connected on the next refresh.`,
      });
    },
  );

  return router;
}
