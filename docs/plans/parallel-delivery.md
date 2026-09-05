# Parallel software delivery

This execution plan supports the full
[software-stability roadmap](software-stability-roadmap.md). It changes work
allocation, not acceptance criteria. ESP32 measurements, VDP and sound remain
outside the current software gate.

## Ownership and scheduling

Four agent slots are available, including the integration lead. Run three
bounded component assignments alongside Triptych integration. Rotate completed
slots into repair and independent post-fix review.

| Scope            | Work                                                                              | Required evidence                                                               |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ATOM and Nucleus | Toolchain identity, generated images, package/runtime boundary, compiler commands | Deterministic regeneration, isolated package tests, compiler execution          |
| Edit             | Buffer/navigation/rendering, save recovery, released application                  | Boundary regressions, complete editor proof, consumer sessions                  |
| Portable CP/M    | CCP/BDOS contracts, profiles, failure behavior, artifacts                         | Component tests, alternate placement, guest assembly, green CI artifacts        |
| Triptych         | BIOS, distribution, native/WASM hosts, persistence, publication                   | Pinned inputs, native PTY, headless/browser workflows, hosted-byte verification |
| Debug80          | Optional standalone-component consumption                                         | Package contents and clean installation after component pins advance            |

Each writable assignment has one repository or disjoint file set. Reviewers
are read-only. Agents must not run competing generators against shared output
directories. Private temporary probes can run concurrently. The integration
lead owns cross-repository pins, releases and final acceptance.

## Review sequence

1. Freeze the reviewed revision and record dirty files separately.
2. Run independent adversarial review against correctness, data integrity,
   ownership, error handling, bounds, reproducibility and maintainability.
3. Reproduce actionable findings with focused tests before changing code.
4. Assign each repair to an exclusive writer. Preserve its intended interface.
5. Give the repair to a reviewer who did not implement it. The lead verifies
   important findings and resolves disagreements using execution evidence.
6. Run the component's full check and CI, then advance consumer pins.
7. Run the assembled system's acceptance tests on the exact release inputs.

The first coverage wave uses one independent reviewer per component group plus
lead verification. This is not a claim of a multi-reviewer panel for every
file. Higher-risk repairs receive additional review as slots become available.
Reviewer agreement alone does not establish correctness.

## Publication boundary

Use source revisions and artifact digests, not an agent's success summary, to
select inputs. Publish CI-produced artifacts after the matching commit passes
and review findings are resolved. Re-download release assets and compare their
bytes. S2 is incomplete until Triptych consumes the OS release; S4–S7 still
require deterministic distribution, native/WASM parity and hosted acceptance.
