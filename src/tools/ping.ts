import { z } from "zod";

/**
 * Logique pure du tool `ping` : input → output, sans état partagé.
 * Sert de health check pour vérifier que le serveur répond.
 */
export const pingInputSchema = {
  message: z.string().optional().describe("Optional message echoed back in the pong"),
};

export function ping(input: { message?: string }): string {
  return input.message ? `pong: ${input.message}` : "pong";
}
