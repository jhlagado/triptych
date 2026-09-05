// SPDX-License-Identifier: GPL-3.0-or-later
// Bring the hill key back to the cave. Commands are single uppercase keys.
sub main() fails
    var room as u8 = 0
    var key as u8
    var found as boolean = false
    say("\r\nHILL KEY: fetch the key and return home.\r\nE east, W west, T take, Q quit.\r\n") else fail
    while true
        if room = 0
            if found
                say("\r\nYou win! The key opens your cave.\r\n") else fail
                return
            end
            say("\r\nCAVE> ") else fail
        else
            say("\r\nHILL> ") else fail
        end
        key = readInputByte() else fail
        if key = 13 or key = 10
            continue
        elseif key = 'Q'
            say("\r\nBye.\r\n") else fail
            return
        elseif key = 'E'
            room = 1
        elseif key = 'W'
            room = 0
        elseif key = 'T'
            if room = 1
                found = true
                say("\r\nYou have the key. Go west.\r\n") else fail
            else
                say("\r\nNo key here. Go east.\r\n") else fail
            end
        else
            say("\r\nUse E, W, T or Q.\r\n") else fail
        end
    end
end
