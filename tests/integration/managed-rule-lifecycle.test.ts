import { describe, expect, it } from "vitest";
import { FireflyError } from "../../src/errors.js";
import { FireflyService } from "../../src/service.js";

type State = Record<string, unknown>;
type DescriptionWriteMode = "preserve" | "legacy" | undefined;

function resource(id: string, state: State) {
  return { data: { type: "rules", id, attributes: state } };
}

function rule(id: string, overrides: State = {}) {
  return {
    title: "Rule",
    description: "[openclaw-firefly:managed:v1]\nNotes",
    rule_group_id: "7",
    trigger: "store-journal",
    order: 3,
    active: false,
    strict: true,
    stop_processing: false,
    triggers: [{ type: "description_starts", value: "OLD", active: true, prohibited: false, stop_processing: false, order: 1 }],
    actions: [{ type: "set_description", value: "new", active: true, stop_processing: false, order: 1 }],
    ...overrides,
  };
}

function mock(initial: State) {
  let state = structuredClone(initial);
  const puts: State[] = [];
  let triggers = 0;
  let readAfterPutError: FireflyError | undefined;
  let didPut = false;
  let failPut = false;
  let resetEntryFlags = false;
  let encodeDescriptionAfterPut = false;
  let descriptionWriteMode: DescriptionWriteMode;
  let executionError: FireflyError | undefined;
  let executionResponse: unknown;

  const write = (body: State) => {
    const previousDescription = state.description;
    state = { ...state, ...body };
    if (descriptionWriteMode === "preserve") state.description = previousDescription;
    if (descriptionWriteMode === "legacy") state.description = "[openclaw-firefly:pending:v1;digest=bad]\nCorrupted";
    if (encodeDescriptionAfterPut && typeof state.description === "string") {
      state.description = state.description.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    }
    if (resetEntryFlags) {
      for (const key of ["triggers", "actions"] as const) {
        if (Array.isArray(state[key])) {
          state[key] = state[key].map((entry) => ({ ...(entry as State), active: true, stop_processing: false }));
        }
      }
    }
  };

  const client = {
    get: async (path: string) => {
      if (path === "/about") throw new Error("Rule operations must not query or gate on the backend version");
      if (path.startsWith("/rules/")) {
        if (didPut && readAfterPutError !== undefined) throw readAfterPutError;
        return resource(path.split("/").at(-1)!, state);
      }
      if (path === "/search/transactions") {
        return { data: [], meta: { pagination: { total: 0, count: 0, per_page: 100, current_page: 1, total_pages: 1 } } };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string, body: State) => {
      if (path === "/rules") {
        write(body);
        return resource("101", state);
      }
      if (path.endsWith("/trigger")) {
        triggers += 1;
        if (executionError !== undefined) throw executionError;
        return executionResponse;
      }
      throw new Error(`unexpected POST ${path}`);
    },
    put: async (_path: string, body: State) => {
      if (failPut) throw new FireflyError("FIREFLY_TIMEOUT", "timeout");
      didPut = true;
      puts.push(body);
      write(body);
      return resource("101", state);
    },
    delete: async () => undefined,
  };

  return {
    service: new FireflyService(client as never),
    state: () => state,
    puts: () => puts,
    triggers: () => triggers,
    failReadAfterPut: (error = new FireflyError("FIREFLY_TIMEOUT", "timeout")) => { readAfterPutError = error; },
    failPut: () => { failPut = true; },
    resetEntryFlags: () => { resetEntryFlags = true; },
    encodeDescriptionAfterPut: () => { encodeDescriptionAfterPut = true; },
    descriptionWrite: (mode: Exclude<DescriptionWriteMode, undefined>) => { descriptionWriteMode = mode; },
    failExecution: () => { executionError = new FireflyError("FIREFLY_TIMEOUT", "timeout"); },
    nonEmptyExecutionResponse: () => { executionResponse = { data: { unexpected: true } }; },
  };
}

describe("managed rule lifecycle", () => {
  it("previews and executes without querying the backend version", async () => {
    const m = mock(rule("101", { active: true }));
    await expect(m.service.testRule({ id: "101" })).resolves.toMatchObject({ executionBackend: "firefly-rule-trigger" });
    await expect(m.service.executeRule("101", true)).resolves.toMatchObject({ executed: true, executionScope: "all-accounts-all-dates" });
    expect(m.triggers()).toBe(1);
  });

  it("creates inactive managed rules and reads back Firefly's stored state", async () => {
    const m = mock(rule("101"));
    const created = await m.service.createRule({ title: "Rule", description: "hello", ruleGroupId: "7", triggers: [{ type: "description_starts", value: "OLD" }], actions: [{ type: "set_description", value: "new" }] });
    expect(created).toMatchObject({ id: "101", active: false, managed: true, description: "[openclaw-firefly:managed:v1]\nhello" });
  });

  it("updates a stale legacy marker losslessly while inactive", async () => {
    const m = mock(rule("115", { description: "[openclaw-firefly:pending:v1;id=stale;digest=bad]\nClaudia note", actions: [{ type: "set_description", value: "keep", active: true, stop_processing: true, order: 9 }] }));
    const updated = await m.service.updateRule({ id: "115", triggers: [{ type: "description_starts", value: "Zelle payment to CLAUDIA JPM" }] });
    expect(updated.active).toBe(false);
    expect(updated.description).toBe("[openclaw-firefly:managed:v1]\nClaudia note");
    expect(m.puts()[0]).toMatchObject({ description: "[openclaw-firefly:managed:v1]\nClaudia note", triggers: [{ value: "Zelle payment to CLAUDIA JPM" }] });
    expect(m.puts()[0]).not.toHaveProperty("actions");
    expect(m.state().actions).toEqual([{ type: "set_description", value: "keep", active: true, stop_processing: true, order: 9 }]);
  });

  it("rejects successful writes that do not store the requested managed:v1 description", async () => {
    const create = mock(rule("101"));
    create.descriptionWrite("preserve");
    await expect(create.service.createRule({ title: "Created", description: "Requested", ruleGroupId: "7", triggers: [{ type: "description_starts", value: "OLD" }], actions: [{ type: "set_description", value: "new" }] })).rejects.toMatchObject({ code: "FIREFLY_INVALID_RESPONSE" });
    expect(create.state()).toMatchObject({ title: "Created", description: "[openclaw-firefly:managed:v1]\nNotes" });

    const update = mock(rule("101", { title: "Old", description: "[openclaw-firefly:pending:v1;digest=bad]\nNotes" }));
    update.descriptionWrite("preserve");
    await expect(update.service.updateRule({ id: "101", title: "Updated" })).rejects.toMatchObject({ code: "FIREFLY_INVALID_RESPONSE" });
    expect(update.state()).toMatchObject({ title: "Updated", description: "[openclaw-firefly:pending:v1;digest=bad]\nNotes" });

    const activate = mock(rule("101"));
    activate.descriptionWrite("legacy");
    await expect(activate.service.activateRule("101", true)).rejects.toMatchObject({ code: "FIREFLY_INVALID_RESPONSE" });
    expect(activate.state()).toMatchObject({ active: true, description: "[openclaw-firefly:pending:v1;digest=bad]\nCorrupted" });

    const deactivate = mock(rule("101", { active: true }));
    deactivate.descriptionWrite("legacy");
    await expect(deactivate.service.deactivateRule("101", true)).rejects.toMatchObject({ code: "FIREFLY_INVALID_RESPONSE" });
    expect(deactivate.state()).toMatchObject({ active: false, description: "[openclaw-firefly:pending:v1;digest=bad]\nCorrupted" });
  });

  it("preserves explicit array flags and verifies them in the GET readback", async () => {
    const m = mock(rule("101"));
    const triggers = [{ type: "description_starts" as const, value: "NEW", prohibited: true, active: false, stopProcessing: true }];
    const actions = [{ type: "set_description" as const, value: "updated", active: false, stopProcessing: true }];
    m.encodeDescriptionAfterPut();
    await expect(m.service.updateRule({ id: "101", description: "A & <B>", triggers, actions })).resolves.toMatchObject({
      description: "[openclaw-firefly:managed:v1]\nA & <B>",
      triggers: [{ type: "description_starts", value: "NEW", prohibited: true, active: false, stopProcessing: true }],
      actions: [{ type: "set_description", value: "updated", active: false, stopProcessing: true }],
    });
    expect(m.puts()[0]).toMatchObject({ triggers: [{ prohibited: true, active: false, stop_processing: true }], actions: [{ active: false, stop_processing: true }] });

    const reset = mock(rule("102"));
    reset.resetEntryFlags();
    await expect(reset.service.updateRule({ id: "102", triggers })).rejects.toMatchObject({ code: "FIREFLY_INVALID_RESPONSE" });
  });

  it("requires confirmation, toggles with minimal writes, and leaves legacy no-ops untouched", async () => {
    const m = mock(rule("101"));
    await expect(m.service.activateRule("101", false)).rejects.toMatchObject({ code: "FIREFLY_CONFIRMATION_REQUIRED" });
    expect(await m.service.activateRule("101", true)).toMatchObject({ changed: true, rule: { active: true } });
    expect(m.puts()[0]).toEqual({ active: true, description: "[openclaw-firefly:managed:v1]\nNotes" });
    expect(await m.service.activateRule("101", true)).toMatchObject({ changed: false });
    expect(await m.service.deactivateRule("101", true)).toMatchObject({ changed: true, rule: { active: false } });
    expect(m.triggers()).toBe(0);
    expect(await m.service.deactivateRule("101", true)).toMatchObject({ changed: false });

    const activeLegacy = mock(rule("102", { active: true, description: "[openclaw-firefly:confirmed:v1;digest=old]\nNotes" }));
    await expect(activeLegacy.service.activateRule("102", true)).resolves.toMatchObject({ changed: false });
    expect(activeLegacy.puts()).toHaveLength(0);
    const inactiveLegacy = mock(rule("103", { description: "[openclaw-firefly:pending:v1;digest=old]\nNotes" }));
    await expect(inactiveLegacy.service.deactivateRule("103", true)).resolves.toMatchObject({ changed: false });
    expect(inactiveLegacy.puts()).toHaveLength(0);
  });

  it("deletes only confirmed inactive managed rules and reports uncertain writes honestly", async () => {
    const m = mock(rule("101"));
    await expect(m.service.deleteRule("101", false)).rejects.toMatchObject({ code: "FIREFLY_CONFIRMATION_REQUIRED" });
    await expect(m.service.deleteRule("101", true)).resolves.toEqual({ id: "101", deleted: true });
    m.failPut();
    await expect(m.service.activateRule("101", true)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
    const readback = mock(rule("101")); readback.failReadAfterPut();
    await expect(readback.service.activateRule("101", true)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN", message: expect.stringContaining("101") });
    const notFoundReadback = mock(rule("101")); notFoundReadback.failReadAfterPut(new FireflyError("FIREFLY_NOT_FOUND", "not found", 404));
    await expect(notFoundReadback.service.activateRule("101", true)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN", message: expect.stringContaining("101") });
  });

  it("executes active legacy-confirmed rules once and treats timeout or non-empty responses as uncertain", async () => {
    const m = mock(rule("101", { active: true, description: "[openclaw-firefly:confirmed:v1;digest=obsolete]\nOld note" }));
    await expect(m.service.executeRule("101", false)).rejects.toMatchObject({ code: "FIREFLY_CONFIRMATION_REQUIRED" });
    await expect(m.service.executeRule("101", true)).resolves.toEqual({ id: "101", executed: true, executionScope: "all-accounts-all-dates" });
    expect(m.triggers()).toBe(1);

    const timeout = mock(rule("102", { active: true }));
    timeout.failExecution();
    await expect(timeout.service.executeRule("102", true)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
    expect(timeout.triggers()).toBe(1);
    const nonEmpty = mock(rule("103", { active: true }));
    nonEmpty.nonEmptyExecutionResponse();
    await expect(nonEmpty.service.executeRule("103", true)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
    expect(nonEmpty.triggers()).toBe(1);
  });
});
