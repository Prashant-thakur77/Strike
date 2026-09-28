import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { StrikeError, describeError, epochManagerAbi, explainError, revertErrorName } from "../src/index.js";

function revert(errorName: "MarketClosed" | "WrongState", args: readonly unknown[]) {
  const data = encodeErrorResult({ abi: epochManagerAbi, errorName, args } as never);
  const cause = new ContractFunctionRevertedError({ abi: epochManagerAbi, data, functionName: "openEpoch" });
  return new ContractFunctionExecutionError(cause, {
    abi: epochManagerAbi,
    functionName: "openEpoch",
    args: [],
  });
}

describe("errors", () => {
  it("decodes a contract revert to its custom error", () => {
    const err = revert("MarketClosed", [1791212400n]);
    expect(revertErrorName(err)).toBe("MarketClosed");
    expect(describeError(err)).toBe("MarketClosed(1791212400)");
    expect(explainError(err)).toMatch(/^MarketClosed\(1791212400\): NYSE is closed/);
  });

  it("formats enum arguments", () => {
    expect(describeError(revert("WrongState", [1, 2]))).toBe("WrongState(1, 2)");
  });

  it("passes other errors through", () => {
    expect(describeError(new StrikeError("read-only"))).toBe("read-only");
    expect(describeError("boom")).toBe("boom");
    expect(revertErrorName(new Error("x"))).toBeUndefined();
    expect(explainError(new Error("plain"))).toBe("plain");
  });
});
