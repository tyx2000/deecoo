import { runAgent } from "./loop.js";
import { createSubagentRuntime } from "./subagents/runtime.js";
import { analyzeTaskCoordination } from "./coordination.js";
import { buildContextMessages, contextItem } from "../context/builder.js";
import { buildProjectIndex, buildProjectIndexMessages } from "../context/projectIndex.js";
import { buildReviewScopeMessages } from "../context/reviewScope.js";
import { buildTaskSpec, taskSpecMessage } from "../harness/taskSpec.js";
import { loadProjectMemory, memoryContextMessage, recordProjectMemory, summarizeRunForMemory } from "../memory/projectMemory.js";
import { saveRunAudit } from "../observability/audit.js";
import { saveRunOutputs } from "../reporter/outputs.js";
import { createReviewFinalValidator } from "../reporter/reviewReport.js";
import { buildSessionContext, recordTurn } from "../session/store.js";
import { artifactContextMessages, saveSkillArtifact } from "../session/artifacts.js";
import { isScorActive, scorArtifactMetadata, scorReviewToolPolicy } from "../skills/scor.js";
import { createAssistantStreamPrinter, formatRunFooter, formatToolLine, printAssistantResponse } from "../terminal/markdown.js";
import { createSpinner } from "../terminal/spinner.js";
import { formatActivityBlock, printCoordinationPlan } from "../cli/activity.js";
import { buildVerificationPlan, verificationPlanMessage } from "../verification/planner.js";

export async function runTask({ client, tools, task, cwd, config, sessionStore, session, activeSkills = [], signal }) {
  const spinner = createSpinner("Thinking");
  const streamPrinter = createAssistantStreamPrinter();
  let streamed = false;
  let streamedContent = "";
  const startedAt = Date.now();
  const contextMessages = session ? buildSessionContext(session) : [];
  const handoffMessages = await buildSkillHandoffMessages({ sessionStore, session, activeSkills });
  const coordination = analyzeTaskCoordination(task);
  const taskSpec = buildTaskSpec({ task, cwd, coordination, activeSkills });
  const projectIndex = await buildProjectIndex(cwd);
  const projectIndexMessages = await buildProjectIndexMessages(cwd);
  const memory = sessionStore ? await loadProjectMemory(sessionStore) : undefined;
  const memoryMessage = memoryContextMessage(memory);
  const verificationPlan = buildVerificationPlan({ taskSpec, projectIndex });
  const baseContextMessages = buildContextMessages([
    contextItem(taskSpecMessage(taskSpec), 100),
    contextItem(verificationPlanMessage(verificationPlan), 90),
    contextItem(memoryMessage, 80),
    ...contextMessages.map((message) => contextItem(message, 50)),
    ...handoffMessages.map((message) => contextItem(message, 70)),
    ...projectIndexMessages.map((message) => contextItem(message, 60)),
  ]);
  const reviewScopeMessages = await buildReviewScopeMessages({
    cwd,
    task,
    activeSkills,
    requestType: coordination.requestType,
  });
  tools.resetTaskPermissions?.();
  if (isScorActive(activeSkills) && coordination.requestType === "review") {
    tools.setTaskToolPolicy?.(scorReviewToolPolicy());
  }
  tools.setSubagentRuntime?.(
    createSubagentRuntime({
      client,
      createWorkerTools: tools.createWorkerTools?.bind(tools),
      workerTools: tools.createWorkerTools?.({ mode: "research" }) ?? tools,
      cwd,
      config,
      activeSkills,
      contextMessages: [...baseContextMessages, ...reviewScopeMessages],
      signal,
    }),
  );
  printCoordinationPlan(coordination);

  try {
    const result = await runAgent({
      client,
      tools,
      task,
      cwd,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      thinking: config.thinking,
      stream: coordination.requestType === "review" ? false : config.stream,
      contextMessages: [...baseContextMessages, ...reviewScopeMessages],
      activeSkills,
      finalValidator: coordination.requestType === "review" ? createReviewFinalValidator() : undefined,
      signal,
      onModelStart: () => spinner.start(),
      onModelEnd: () => spinner.stop(),
      onToolStart: () => {},
      onToolEnd: ({ name, args, result }) => {
        spinner.stop();
        console.log(formatActivityBlock({ name, args, result }) + "\n");
      },
      onTextDelta: ({ content }) => {
        spinner.stop();
        streamed = true;
        streamedContent += content;
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
    if (streamed && finalTextWasStreamed(streamedContent, result.finalText)) {
      streamPrinter.finish(footer);
    } else if (streamed) {
      streamPrinter.finish();
      printAssistantResponse(result.finalText, footer);
    } else {
      printAssistantResponse(result.finalText, footer);
    }
    if (session && sessionStore) {
      await saveRunAudit(sessionStore, session, {
        task,
        cwd,
        model: config.model,
        requestType: result.requestType,
        taskSpec,
        verificationPlan,
        elapsedMs,
        usage: result.usage,
        workflow: result.workflow,
        verification: result.verification,
        transitions: result.transitions,
        trace: result.trace,
        reviewReport: result.reviewReport,
        messages: result.messages,
      });
      await saveRunOutputs(sessionStore, session, { task, result });
      for (const entry of summarizeRunForMemory({ task, result })) {
        await recordProjectMemory(sessionStore, entry);
      }
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
    if (isAbortError(error, signal)) {
      if (streamed) streamPrinter.finish();
      console.log(formatToolLine("task interrupted"));
      return {
        elapsedMs: Date.now() - startedAt,
        interrupted: true,
      };
    }
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
    const metadata = {
      task,
      requestType: result.requestType,
      stoppedReason: result.stoppedReason,
      verification: result.verification,
    };
    if (result.reviewReport) metadata.reviewReport = result.reviewReport;
    if (skillName === "s-cor") metadata.scor = scorArtifactMetadata(result.finalText);
    await saveSkillArtifact(sessionStore, session, {
      skillName,
      kind,
      title: skillName + " " + kind,
      content: result.finalText,
      metadata,
    });
  }
}

function finalTextWasStreamed(streamedContent, finalText) {
  const final = String(finalText ?? "").trim();
  if (!final) return true;
  return String(streamedContent ?? "").endsWith(final);
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || /aborted|interrupted/i.test(error?.message ?? "");
}
