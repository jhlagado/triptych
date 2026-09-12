; ATOM Z80 COM fixture. Entry $0100 under CP/M; A contains this program,
; B contains SENTINEL.TXT. Uses private FCB/DMA/stack below the N4 COM ceiling.
; Success returns through page zero to CCP; failure prints FAIL and halts.
; Clobbers AF/BC/DE/HL and private workspace. No caller registers preserved.
ORG $0100
entry:
    LD SP,stk_end
    LD DE,dma
    LD C,26
    CALL 5
    CALL readsent
    LD A,(dma)
    CP 'O'
    JP NZ,fail
    CALL flush_b
    LD DE,prompt
    CALL print
    LD C,1
    CALL 5
cont:
    ; Closed FCBs and explicit reset relinquish B's old login/allocation state.
    LD DE,2
    LD C,37
    CALL 5
    LD HL,fcb+12
    LD B,24
    XOR A
clearfcb:
    LD (HL),A
    INC HL
    DJNZ clearfcb
    CALL readsent
    LD A,(dma)
    CP 'N'
    JP NZ,fail
    LD DE,new_fcb
    LD C,22
    CALL 5
    CP $FF
    JP Z,fail
    LD DE,new_fcb
    LD C,21
    CALL 5
    OR A
    JP NZ,fail
    LD DE,new_fcb
    LD C,16
    CALL 5
    CP $FF
    JP Z,fail
    CALL flush_b
    ; Direct controller access must reject writing protected A before data.
    XOR A
    OUT ($11),A
    OUT ($12),A
    OUT ($13),A
    OUT ($14),A
    OUT ($15),A
    LD A,2
    OUT ($10),A
    IN A,($17)
    CP 5
    JP NZ,fail
    LD DE,passed
    CALL print
    JP 0

; In: FCB reset, DMA selected. Out: one record in DMA, FCB closed.
; Clobbers AF/BC/DE/HL, flags; balanced stack on success, terminal FAIL otherwise.
readsent:
    LD DE,fcb
    LD C,15
    CALL 5
    CP $FF
    JP Z,fail
    LD DE,fcb
    LD C,20
    CALL 5
    OR A
    JP NZ,fail
    LD DE,fcb
    LD C,16
    CALL 5
    CP $FF
    JP Z,fail
    RET

; In: no live transfer. Out: B checkpoint acknowledged or terminal FAIL.
; Clobbers A/flags; other registers preserved; balanced stack on success.
flush_b:
    LD A,1
    OUT ($11),A
    LD A,3
    OUT ($10),A
    IN A,($17)
    OR A
    JP NZ,fail
    RET

; In: DE dollar-terminated text. Out: printed; clobbers AF/BC/DE/HL/flags.
; Balanced stack; BDOS owns output and does not touch private FCB/DMA buffers.
print:
    LD C,9
    JP 5
fail:
    LD DE,failed
    CALL print
    HALT
    JP fail
prompt: DB "LIVE DISK2 READY",13,10,'$'
passed: DB "LIVE CONTINUED PASS",13,10,'$'
failed: DB "LIVE FAIL",13,10,'$'
fcb: DB 2,"SENTINELTXT"
    DS 24
new_fcb: DB 2,"NEW     TXT"
    DS 24
dma: DS 128
stack: DS 128
stk_end:
