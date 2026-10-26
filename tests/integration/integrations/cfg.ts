/** Mutable config overrides for these tests; read by the config mock in each test file. No imports, so the mock factory can load it. */
export const cfg: {
  forceMock: boolean;
  masterKey: Buffer | undefined;
  masterKeyPrevious: Buffer | undefined;
  masterKeyVersion: number;
} = { forceMock: false, masterKey: undefined, masterKeyPrevious: undefined, masterKeyVersion: 1 };
