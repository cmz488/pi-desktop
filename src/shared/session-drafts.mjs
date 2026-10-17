// Drafts and retry identities belong to their conversation, including while
// another conversation is selected or an earlier submission is still in flight.
export function createSessionDrafts({
  requestId = () => crypto.randomUUID(),
} = {}) {
  const drafts = new Map(),
    attempts = new Map();
  let owner;
  const draft = (id) => {
    if (!drafts.has(id)) drafts.set(id, { text: "", files: [] });
    return drafts.get(id);
  };
  const read = (id = owner) => {
    const value = draft(id);
    return {
      owner: id,
      text: value.text,
      files: value.files.map((file) => ({ ...file })),
    };
  };
  function select(id, currentText) {
    if (currentText !== undefined) draft(owner).text = currentText;
    owner = id;
    return read();
  }
  function edit(text) {
    draft(owner).text = text;
  }
  function addFile(id, file) {
    draft(id).files.push({ ...file });
  }
  function updateFile(id, file) {
    const value = draft(id),
      index = value.files.findIndex((item) => item.id === file.id);
    if (index !== -1) value.files[index] = { ...file };
  }
  function removeFile(id, fileId) {
    const value = draft(id);
    value.files = value.files.filter((file) => file.id !== fileId);
  }
  function capture({ id = owner, text, mode, durable = false }) {
    const value = draft(id);
    if (text !== undefined) value.text = text;
    const files = value.files.map((file) => Object.freeze({ ...file }));
    const message = value.text.trim();
    const signature = JSON.stringify({
      message,
      mode,
      files: files.map((file) => [
        file.name,
        file.type,
        file.data,
        file.kind,
        file.path,
        file.modifiedAt,
      ]),
    });
    let retry = attempts.get(id);
    if (durable && retry?.signature !== signature) {
      retry = { signature, requestId: requestId() };
      attempts.set(id, retry);
    }
    return Object.freeze({
      owner: id,
      text: value.text,
      message,
      mode,
      files: Object.freeze(files),
      retry: durable ? retry : undefined,
    });
  }
  function complete(submission) {
    const value = draft(submission.owner);
    if (value.text === submission.text) value.text = "";
    const sent = new Set(submission.files.map((file) => file.id));
    value.files = value.files.filter((file) => !sent.has(file.id));
    if (submission.retry && attempts.get(submission.owner) === submission.retry)
      attempts.delete(submission.owner);
    return read();
  }
  function totalBytes() {
    return [...drafts.values()].reduce(
      (total, value) =>
        total +
        value.files.reduce(
          (sum, file) => sum + (file.kind === "reference" ? 0 : file.size),
          0,
        ),
      0,
    );
  }
  return Object.freeze({
    read,
    select,
    edit,
    addFile,
    updateFile,
    removeFile,
    capture,
    complete,
    totalBytes,
  });
}
