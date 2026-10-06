---
"hardhat-kms": patch
---

`kms history` now hides ids of 6 or 7 characters, such as a short Google Cloud project id, in user agents, `extra` fields, notes and the scope description. Before, any hidden value shorter than 8 characters was printed. A short id is hidden only as a whole word, so it is never cut out of a longer word. Scope ids are still shown in principals. A short `extraIds` value or reader hidden value is now masked inside a principal too, as a longer one already was.

Issue: [#189](https://github.com/aelmanaa/hardhat-kms/issues/189)
