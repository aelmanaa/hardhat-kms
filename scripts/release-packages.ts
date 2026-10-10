// The release package order, shared by registry checks and the dependency-free tarball checker.
/** The published packages, in the order the scripts install and report them. */
export const PACKAGES: readonly string[] = [
  "hardhat-kms",
  "@hardhat-kms/aws",
  "@hardhat-kms/gcp",
  "@hardhat-kms/azure",
];
