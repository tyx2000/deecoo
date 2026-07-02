import { runAgent } from "./loop.js";
import { createSubagentRuntime } from "./subagents/runtime.js";
import { analyzeTaskCoordination } from "./coordination.js";
import { buildSessionContext, recordTurn } from "../session/store.js";
import { artifactContextMessages, saveSkillArtifact } from "../session/artifacts.js";
import { createAssistantStreamPrinter, formatRunFooter, printAssistantResponse } from "../terminal/markdown.js";
import { createSpinner } from "../terminal/spinner.js";
import { formatActivityLine, formatActivityReason, printCoordinationPlan } from "../cli/activity.js";

export async function runTask({ client, tools, task, cwd, config, sessionStore, session, activeSkills = [] }) {
  const spinner = createSpinner("Thinking");
  const streamPrinter = createAssistantStreamPrinter();
  let streamed = false;
  const startedAt = Date.now();
  const contextMessages = session ? buildSessionContext(session) : [];
  const handoffMessages = await buildSkillHandoffMessages({ sessionStore, session, activeSkills });
  tools.resetTaskPermissions?.();
  tools.setSubagentRuntime?.(
    createSubagentRuntime({
      client,
      workerTools: tools.createWorkerTools?.() ?? tools,
      cwd,
      config,
      activeSkills,
      contextMessages: [...contextMessages, ...handoffMessages],
    }),
  );
  const coordination = analyzeTaskCoordination(task);
  printCoordinationPlan(coordination);

  try {
    const result = await runAgent({
      client,
      tools,
      task,
      cwd,
      maxSteps: config.maxSteps,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      thinking: config.thinking,
      stream: config.stream,
      contextMessages: [...contextMessages, ...handoffMessages],
      activeSkills,
      onModelStart: () => spinner.start(),
      onModelEnd: () => spinner.stop(),
      onToolStart: () => {},
      onToolEnd: ({ name, args, result }) => {
        spinner.stop();
        const reason = result?.cached ? "" : formatActivityReason({ name, args }) + "\n";
        console.log(reason + formatActivityLine({ name, args, result }) + "\n");
      },
      onTextDelta: ({ content }) => {
        spinner.stop();
        streamed = true;
        streamPrinter.push(content);
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const footer = formatRunFooter({
      elapsedMs,
      steps: result.steps,
      usage: result.usage,
      stoppedReason: result.stoppedReason,
    });
    if (streamed) {
      streamPrinter.finish(footer);
    } else {
      printAssistantResponse(result.finalText, footer);
    }
    if (session && sessionStore) {
      await maybeSaveSkillArtifacts({ sessionStore, session, activeSkills, task, result });
      await recordTurn(sessionStore, session, {
        user: task,
        assistant: result.finalText,
        model: config.model,
      });
    }
    return {
      elapsedMs,
      usage: result.usage,
    };
  } catch (error) {
    spinner.stop();
    console.error("Request failed after retries: " + error.message);
    return {
      elapsedMs: Date.now() - startedAt,
    };
  }
}


async function buildSkillHandoffMessages({ sessionStore, session, activeSkills }) {
  if (!sessionStore || !session) return [];
  return artifactContextMessages(sessionStore, session, {
    activeSkillNames: activeSkills.map((skill) => skill.name),
    maxArtifacts: 3,
  });
}

async function maybeSaveSkillArtifacts({ sessionStore, session, activeSkills, task, result }) {
  for (const skill of activeSkills) {
    const skillName = skill.name || skill.id || "skill";
    const kind = skillName === "s-cor" ? "findings" : "output";
    const artifact = await saveSkillArtifact(sessionStore, session, {
      skillName,
      kind,
      title: skillName + " " + kind,
      content: result.finalText,
      metadata: {
        task,
        requestType: result.requestType,
        stoppedReason: result.stoppedReason,
      },
    });
    if (artifact) {
      session.summary = [session.summary, "Skill artifact: " + artifact.path].filter(Boolean).join("\n");
    }
  }
}
