# Runtime Contract Probe

Mocks encode the author's beliefs about the dsh API; this probe encodes
nothing. Wired into a profile, it boots inside the real cordis runtime and
executes every service call the telegram plugin makes — same shapes, same
order — then writes /tmp/dsh-probe-report.jsonl with a SUMMARY verdict.

## Use

    cd ~/.dsh/profiles/desktop
    # wire: add dep dsh-probe -> link:<this dir>, bundle dsh-probe, symlink into node_modules
    rm -f /tmp/dsh-probe-report.jsonl
    # restart Desktop, wait ~10s
    cat /tmp/dsh-probe-report.jsonl | grep SUMMARY
    # unwired afterwards — it creates one probe-* test session per run

Run it before asking a human to test anything that touches a dsh service.
