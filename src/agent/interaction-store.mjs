import { randomUUID } from "node:crypto";
import { DeskError } from "../config/config-store.mjs";
import {
  questionnaireResult,
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_QUESTIONNAIRE_REPLY_LENGTH,
} from "./questionnaire.mjs";

// Auth and extension dialogs are host interactions, never transcript events.
export function createInteractionStore(onChange = () => {}) {
  const jobs = new Map();
  function start(label, run) {
    const job = {
      id: randomUUID(),
      label,
      status: "running",
      events: [],
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    onChange();
    const interaction = {
      signal: job.controller.signal,
      notify: (event) => {
        job.events.push(event);
        job.events = job.events.slice(-12);
        onChange();
      },
      prompt: (prompt) =>
        new Promise((resolve, reject) => {
          const promptId = randomUUID();
          job.prompt = { ...prompt, signal: undefined, id: promptId };
          onChange();
          const finish = (value, error) => {
            cleanup();
            if (job.prompt?.id === promptId) delete job.prompt;
            onChange();
            if (error) reject(error);
            else resolve(value);
          };
          const cancel = () => finish(undefined, new Error("交互已取消"));
          const cleanup = () => {
            prompt.signal?.removeEventListener("abort", cancel);
            job.controller.signal.removeEventListener("abort", cancel);
            delete job.answer;
          };
          job.answer = (value) => finish(value);
          if (prompt.signal?.aborted || job.controller.signal.aborted) {
            cancel();
            return;
          }
          prompt.signal?.addEventListener("abort", cancel, { once: true });
          job.controller.signal.addEventListener("abort", cancel, {
            once: true,
          });
        }),
    };
    Promise.resolve()
      .then(() => run(interaction))
      .then(
        () => {
          job.status =
            job.controller.signal.aborted || job.cancelled
              ? "cancelled"
              : "complete";
        },
        () => {
          job.status = job.controller.signal.aborted ? "cancelled" : "failed";
          job.error = "操作未完成，请检查凭据或提供商连接后重试";
        },
      )
      .finally(() => {
        delete job.answer;
        delete job.prompt;
        onChange();
      });
    return job.id;
  }
  return {
    start,
    list: () =>
      [...jobs.values()].map(
        ({ id, label, status, events, prompt, error }) => ({
          id,
          label,
          status,
          events,
          prompt,
          error,
        }),
      ),
    // Native UI and remote UI race through the same one-shot resolver.
    settle(id, value) {
      const job = jobs.get(id);
      if (job?.answer) {
        job.cancelled = value?.cancelled === true;
        job.answer(value);
      }
    },
    reply(input) {
      const job = jobs.get(input.id);
      if (!job) throw new DeskError(404, "交互不存在");
      if (input.cancel) {
        if (
          job.status !== "running" ||
          (input.promptId && input.promptId !== job.prompt?.id)
        )
          throw new DeskError(409, "交互已变化，请重新读取");
        job.controller.abort();
        return;
      }
      if (input.dismiss && job.status !== "running") {
        jobs.delete(job.id);
        return;
      }
      if (
        !job.answer ||
        input.promptId !== job.prompt?.id ||
        typeof input.value !== "string"
      )
        throw new DeskError(409, "交互已变化，请重新读取");
      const answerLimit =
        job.prompt.type === "questionnaire"
          ? MAX_QUESTIONNAIRE_REPLY_LENGTH
          : MAX_CUSTOM_ANSWER_LENGTH;
      if (input.value.length > answerLimit)
        throw new DeskError(422, "答案过长，请缩短后重试");
      if (
        job.prompt.type === "select" &&
        !job.prompt.options.some((option) => option.id === input.value)
      )
        throw new DeskError(422, "选项无效");
      job.answer(
        job.prompt.type === "questionnaire"
          ? questionnaireResult(job.prompt.questions, input.value)
          : input.value,
      );
    },
    cancelAll: () => {
      for (const job of jobs.values()) job.controller.abort();
    },
    get running() {
      return [...jobs.values()].some((job) => job.status === "running");
    },
  };
}
