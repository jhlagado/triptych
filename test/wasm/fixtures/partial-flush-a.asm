; Disposable checkpoint proof. No stack, RAM or CP/M resident use.
; B record 0 becomes dirty, then A evicts it and alone acknowledges a flush.
ORG $0000
    XOR A
    OUT ($12),A
    OUT ($13),A
    OUT ($14),A
    OUT ($15),A
    LD A,1
    OUT ($11),A
    LD A,2
    OUT ($10),A
    LD B,128
    LD A,$72
dirty:
    OUT ($16),A
    DJNZ dirty
    XOR A
    OUT ($11),A
    LD A,2
    OUT ($10),A
    LD B,128
    LD A,$61
ackloop:
    OUT ($16),A
    DJNZ ackloop
    LD A,3
    OUT ($10),A
    IN A,($10)
    AND $04
    JR NZ,failed
    LD A,'F'
    OUT ($00),A
    HALT
failed:
    LD A,'!'
    OUT ($00),A
    HALT
