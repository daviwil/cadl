import { deepStrictEqual, strictEqual } from "assert";
import { IntrinsicType, ModelType, OperationType, Type } from "../../core/types.js";
import { createTestHost, TestHost } from "../../testing/index.js";

function expectParams(parameters: ModelType, paramNames: string[]) {
  deepStrictEqual(paramNames, Array.from(parameters.properties.keys()));
}

function expectModelNamed(maybeModel: Type, name: string) {
  strictEqual(maybeModel.kind, "Model");
  strictEqual((maybeModel as ModelType).name, name);
}

describe("cadl: operations", () => {
  let testHost: TestHost;

  beforeEach(async () => {
    testHost = await createTestHost();
  });

  it("can return void", async () => {
    testHost.addCadlFile(
      "main.cadl",
      `
      @test op foo(): void;
    `
    );

    const { foo } = (await testHost.compile("./main.cadl")) as { foo: OperationType };
    strictEqual(foo.returnType.kind, "Intrinsic");
    strictEqual((foo.returnType as IntrinsicType).name, "void");
  });

  // it.only("can reuse operation declarations as signatures for new declarations", async () => {
  it("can reuse operation declarations as signatures for new declarations", async () => {
    testHost.addCadlFile(
      "main.cadl",
      `
      op foo(name: string, age: int32): boolean;
      @test op newFoo: foo;

      interface InterfaceOperationsToo {
        @test newFooToo: foo;
      }
    `
    );

    const [result, diagnostics] = await testHost.compileAndDiagnose("./main.cadl");
    console.log("DIAG:", diagnostics);

    const { newFoo, newFooToo } = result as {
      newFoo: OperationType;
      newFooToo: OperationType;
    };

    expectParams(newFoo.parameters, ["name", "age"]);
    expectModelNamed(newFoo.returnType, "boolean");

    expectParams(newFoo.parameters, ["name", "age"]);
    expectModelNamed(newFooToo.returnType, "boolean");
  });

  it.only("can reuse templated operation declarations as signatures for new declarations", async () => {
    testHost.addCadlFile(
      "main.cadl",
      `
      model StringA is string {};
      model StringB is string {};
      model PayloadA {};
      model PayloadB {};

      op foo<TString, TPayload>(name: TString, payload: TPayload): boolean;
      @test op newFoo: foo<StringA, PayloadA>;

      interface InterfaceOperationsToo {
        @test newFooToo: foo<StringB, PayloadB>;
      }
    `
    );

    const { newFoo, newFooToo } = (await testHost.compile("./main.cadl")) as {
      newFoo: OperationType;
      newFooToo: OperationType;
    };

    expectParams(newFoo.parameters, ["name", "payload"]);
    expectModelNamed(newFoo.returnType, "boolean");

    expectParams(newFoo.parameters, ["name", "payload"]);
    expectModelNamed(newFooToo.returnType, "boolean");
  });

  it.only("reused operation signatures have original operation decorators re-applied", async () => {});

  it.only("reused operation signature parameters are generated from original node", async () => {});

  it.only("cannot use an operation signature that reuses another signature", async () => {});
});
