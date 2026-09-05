# Nucleus release input

`NUC.COM` and its upstream manifest are from
[`jhlagado/nucleus` nucleus-v0.3.1](https://github.com/jhlagado/nucleus/releases/tag/nucleus-v0.3.1),
commit `b5276a85fd36600a10dbd65039f0af3afc033f0d`.
The source and build tools are available at that immutable upstream revision.
The copied licence is GPL-3.0-only, as declared by the upstream package.

`PROVENANCE.json` binds the executable and manifest bytes to the reviewed
source revision and release asset. The compiler uses ATOM and its CP/M command
accepts one physical source file. This release completes native ATOM source
migration and includes the separately tested CP/M parameter-name identity repair.
The [integration checkpoint](../../docs/reports/nucleus-native-release.md)
records qualification and the remaining hosted acceptance work.

These files prepare the fresh distribution. They do not replace NUC on a
saved working disk or alter the frozen historical compatibility fixture.
