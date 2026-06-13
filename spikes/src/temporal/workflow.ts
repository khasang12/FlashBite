import { condition, defineSignal, setHandler, sleep } from "@temporalio/workflow";

export const approveSignal = defineSignal<[boolean]>("approve");

/**
 * Races an SLA timer against a merchant-approval signal.
 * Returns "APPROVED" if the signal arrives in time, "SLA_BREACH" otherwise.
 * This is the corrected single-handler pattern (the PRD registered the handler twice).
 */
export async function slaRaceWorkflow(slaSeconds: number): Promise<string> {
  let approved: boolean | undefined;
  setHandler(approveSignal, (value) => {
    approved = value;
  });

  const signalledInTime = await condition(() => approved !== undefined, `${slaSeconds}s`);

  if (signalledInTime && approved) return "APPROVED";
  if (signalledInTime && !approved) return "DECLINED";
  return "SLA_BREACH";
}
