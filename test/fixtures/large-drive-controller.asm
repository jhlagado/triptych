; Host-boundary probe, not a CP/M BIOS. ATOM assembles this complete boot ROM.
; A packet is command, drive, four little-endian record bytes, and (for WRITE)
; 128 payload bytes. Command zero halts. Every other command replies with its
; initial error, then READ's 128 data bytes (if applicable), then final error,
; four record-register bytes and status. Capturing the initial error separates
; address rejection from the subsequent attempted transfer's protocol error.
        ORG 0000h
        LD SP,8000h
NEXT:
        CALL RECEIVE
        OR A
        JR Z,DONE
        LD D,A
        CALL RECEIVE
        OUT (11h),A
        LD C,12h
        LD B,4
ADDRESS:
        CALL RECEIVE
        OUT (C),A
        INC C
        DJNZ ADDRESS
        LD A,D
        OUT (10h),A
        IN A,(17h)
        OUT (00h),A
        LD A,D
        CP 2
        JR Z,WRITE
        CP 1
        JR NZ,RESULT
        LD B,128
READ:
        IN A,(16h)
        OUT (00h),A
        DJNZ READ
        JR RESULT
WRITE:
        LD B,128
SEND:
        CALL RECEIVE
        OUT (16h),A
        DJNZ SEND
RESULT:
        IN A,(17h)
        OUT (00h),A
        LD C,12h
        LD B,4
REGS:
        IN A,(C)
        OUT (00h),A
        INC C
        DJNZ REGS
        IN A,(10h)
        OUT (00h),A
        JR NEXT
DONE:
        HALT

; RECEIVE waits for one serial byte. Returns A; preserves BC/DE/HL and SP.
; Flags are unspecified. The polling host is responsible for bounded execution.
RECEIVE:
        IN A,(01h)
        AND 1
        JR Z,RECEIVE
        IN A,(00h)
        RET
        DS 0100h-$
