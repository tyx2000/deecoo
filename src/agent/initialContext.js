import { buildSystemPrompt } from "./prompt.js";
import { CONTENT_TRUST_INSTRUCTION } from "../harness/contentTrust.js";

// Planning and dispatch must reserve the identical instruction/trust envelope.
export function buildAgentSystemMessage({ cwd, requestType, activeSkills = [], coordination, trustToolOutput = true }) {
  const content = buildSystemPrompt(cwd, requestType, activeSkills, coordination);
  return { role: "system", content: trustToolOutput ? content + "\n\n" + CONTENT_TRUST_INSTRUCTION : content };
}
