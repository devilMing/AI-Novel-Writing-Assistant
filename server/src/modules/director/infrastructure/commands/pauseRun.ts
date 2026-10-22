import type {Prisma} from "@prisma/client";
import type {RunContract} from "../../domain";

/** Business pause joins the control transition transaction so the director and prose job stop together. */
export type BusinessPause = (contract: RunContract, tx: Prisma.TransactionClient) => Promise<void>;

export async function commitExplicitPause(
  tx: Prisma.TransactionClient,
  contract: RunContract,
  pauseBusiness?: BusinessPause,
): Promise<void> {
  await pauseBusiness?.(contract, tx);
}
