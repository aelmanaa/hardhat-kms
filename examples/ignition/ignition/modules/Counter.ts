import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys the counter and adds 5 to it, both from Ignition's sender.
export default buildModule("Counter", (m) => {
  const counter = m.contract("Counter", ["deployed with KMS", 7n]);
  m.call(counter, "add", [5n]);
  return { counter };
});
