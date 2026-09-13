# Caverns release input

Copyright 1982–83 John Hardy. Caverns began on the ZX81 in 1982 and reached its
Microbee release in 1983. This is the author's revised native ATOM CP/M port.

`CAVERNS.COM` and the unmodified `manifest.json` were downloaded from the
[successful upstream Linux CI artifact](https://github.com/jhlagado/caverns80/actions/runs/34741053850/artifacts/10312239657) for revision `3b056f35ecf864063434700dad39263ff65e827f`.
The executable SHA-256 is `b29797e09ff7b54c7caeb99bf0ed9583c371a42022dbad4fbe8d418f77cb3270`.

Triptych installs these verified bytes into fresh images. It does not rebuild
or fork the game. The [upstream source](https://github.com/jhlagado/caverns80/tree/3b056f35ecf864063434700dad39263ff65e827f)
and included GPLv3 licence accompany this input. The game's story and HELP are
embedded in the COM; no companion text file is needed to play.

Type `CAVERNS` at the CP/M prompt. Existing saved disks retain their contents;
install the game explicitly through the Files workflow if it is absent. Save
your game and download a disk backup before updating an existing copy.

Release 0.1.1 permits C/CANCEL at voluntary QUIT/RESTART prompts and makes the
dead-end inscription available through READ. Fatal endings cannot be cancelled.
