import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// The annotation is for the repository's isolatedDeclarations setting; a project does not need it.
/** Deploys a counter and adds 5 to it, both from Ignition's sender. */
const counterModule: ReturnType<typeof buildModule> = buildModule("Counter", (m) => {
  const label = m.getParameter("label", "ignition");
  const counter = m.contract("Counter", [label, 7n]);
  m.call(counter, "add", [5n]);
  return { counter };
});

export default counterModule;
