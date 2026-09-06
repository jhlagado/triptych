; Test-only synthetic CCP, not an operating-system or application proof.
; The real cold bootstrap enters here. Leave A in provider backing storage
; without a checkpoint and B in the controller's dirty cache, then warm boot.
        ORG $E300
SETUP:
        xor a
        out ($11),a
        out ($12),a
        out ($14),a
        out ($15),a
        ld a,1
        out ($13),a
        ld a,$31
        call WRREC
        ld a,1
        out ($11),a
        ld a,4
        out ($12),a
        ld a,$72
        call WRREC
        ld a,1
        ld ($0004),a
WARMREQ:
        jp $F903
WRREC:
        ld d,a
        ld a,2
        out ($10),a
WAITWR:
        in a,($10)
        bit 2,a
        jr nz,SETFAIL
        bit 1,a
        jr z,WAITWR
        ld a,d
        ld b,128
WRBYTE:
        out ($16),a
        djnz WRBYTE
        ret
SETFAIL:
        halt
        jr SETFAIL
SETEND:
