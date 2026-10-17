import { DeskError } from "../config/config-store.mjs";

export const MAX_CUSTOM_ANSWER_LENGTH = 8192;
// Four answers plus JSON framing, bounded below the existing HTTP body limit.
export const MAX_QUESTIONNAIRE_REPLY_LENGTH = 40 * 1024;

/** @typedef {{question: string, header: string, multiSelect?: boolean, options: {label: string, description: string, preview?: string}[]}} AskQuestion */

/** @param {AskQuestion[]} questions @param {string} encoded */
// Adapter for rpiv-ask-user-question's public QuestionnaireResult, not a new tool.
export function questionnaireResult(questions, encoded) {
  let choices;
  try {
    choices = JSON.parse(encoded);
  } catch {
    throw new DeskError(422, "问卷答案格式无效");
  }
  if (!Array.isArray(choices) || choices.length !== questions.length)
    throw new DeskError(422, "请回答所有问题");
  const answers = questions.map((question, questionIndex) => {
    const choice = choices[questionIndex];
    const selected = choice?.selected;
    if (
      !Array.isArray(selected) ||
      new Set(selected).size !== selected.length ||
      selected.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= question.options.length,
      )
    )
      throw new DeskError(422, "问卷选项无效");
    const base = { questionIndex, question: question.question };
    if (typeof choice.custom === "string") {
      if (choice.custom.length > MAX_CUSTOM_ANSWER_LENGTH || selected.length)
        throw new DeskError(422, "自定义答案无效");
      return { ...base, kind: "custom", answer: choice.custom };
    }
    if (question.multiSelect)
      return {
        ...base,
        kind: "multi",
        answer: null,
        selected: selected.map((index) => question.options[index].label),
      };
    if (selected.length !== 1)
      throw new DeskError(422, "请选择一个选项或填写自定义答案");
    const option = question.options[selected[0]];
    return {
      ...base,
      kind: "option",
      answer: option.label,
      ...(option.preview ? { preview: option.preview } : {}),
    };
  });
  return { answers, cancelled: false };
}

// RPC's public dialog walker asks one question at a time. Preserve its offered
// option IDs (including localized Custom option), never reconstruct reply IDs.
/** @param {AskQuestion[] | undefined} questions @param {string} title @param {string} type */
export function rpcQuestion(questions, title, type) {
  const index =
    questions?.findIndex((question) => title.includes(question.question)) ?? -1;
  if (index < 0) return undefined;
  const question = questions[index];
  return {
    ...question,
    index,
    count: questions.length,
    mode:
      type === "select" ? "select" : question.multiSelect ? "multi" : "custom",
  };
}
