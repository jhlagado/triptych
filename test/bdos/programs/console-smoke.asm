; Directly loaded console-only CP/M transient for the Milestone 2 proof.

        ORG     0100H

START:
        LD      DE,MESSAGE
        LD      C,9
        CALL    5
        JP      0

MESSAGE:
        DB      "TRIPTYCH BDOS",13,10,"$"
