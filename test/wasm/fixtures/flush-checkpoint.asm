; Isolated storage test, assembled with ATOM. Entry 0, no stack or RAM use.
; Write/flush record 0 as A, overwrite as B, then evict without flushing.
; HALT leaves a read transfer active. Backing bytes are B; checkpoint is A.
ORG $0000
    XOR A
    OUT ($11),A
    OUT ($12),A
    OUT ($13),A
    OUT ($14),A
    OUT ($15),A
    LD A,2
    OUT ($10),A
    LD B,128
    LD A,'A'
first:
    OUT ($16),A
    DJNZ first
    LD A,3
    OUT ($10),A
    LD A,2
    OUT ($10),A
    LD B,128
    LD A,'B'
second:
    OUT ($16),A
    DJNZ second
    LD A,4
    OUT ($12),A
    LD A,1
    OUT ($10),A
    HALT
