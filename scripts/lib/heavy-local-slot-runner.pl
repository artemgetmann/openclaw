#!/usr/bin/env perl
use strict;
use warnings;
use POSIX qw(setsid);

# Start one guarded command as a dedicated session and process-group leader.
# The shell wrapper owns the machine lease; this runner publishes the exact
# kernel identity that lets the wrapper and later stale-recovery contenders
# distinguish a live orphaned group from a safely reclaimable dead command.

sub inspect_process_identity {
    my ($pid) = @_;
    $pid =~ /^[1-9][0-9]*$/ or die "process identity requires a positive PID\n";

    # Perl's POSIX module exposes setsid() but not getsid()/getpgid() on the
    # supported macOS system Perl. Python's os module calls those POSIX APIs
    # directly, unlike `ps -o sess=` which reports a kernel session pointer
    # (commonly zero on macOS) rather than the numeric session ID.
    my $python = "";
    for my $candidate ("/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3") {
        if (-x $candidate) {
            $python = $candidate;
            last;
        }
    }
    $python ne "" or die "no fixed Python POSIX identity backend is available\n";

    my $query = <<'PYTHON';
import os
import sys

pid = int(sys.argv[1])
print(f"pgid={os.getpgid(pid)}")
print(f"session={os.getsid(pid)}")
PYTHON
    open my $identity, "-|", $python, "-c", $query, "$pid"
        or die "could not start POSIX identity backend: $!\n";
    my @lines = <$identity>;
    close $identity
        or die "could not inspect process identity for PID $pid\n";
    my $result = join "", @lines;
    $result =~ /^pgid=[1-9][0-9]*\nsession=[1-9][0-9]*\n\z/
        or die "POSIX identity backend returned invalid data for PID $pid\n";
    print $result;
}

if (@ARGV == 2 && $ARGV[0] eq "--inspect-process") {
    inspect_process_identity($ARGV[1]);
    exit 0;
}

@ARGV >= 2 or die "usage: heavy-local-slot-runner.pl <lock-path> <command> [args...]\n";
my $lock_path = shift @ARGV;
my $program = shift @ARGV;
my $expected_token = $ENV{OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN} // "";
my $owner_path = "$lock_path/owner";
my $pending_path = "$lock_path/child_pending";
my $committed_path = "$lock_path/child_committed";
my $authorized_path = "$lock_path/child_authorized";
my $metadata_path = "$lock_path/child_pid";

sub metadata_value {
    my ($path, $key) = @_;
    open my $handle, "<", $path or return "";
    while (my $line = <$handle>) {
        chomp $line;
        if ($line =~ /^\Q$key\E=(.*)$/) {
            close $handle;
            return $1;
        }
    }
    close $handle;
    return "";
}

sub process_start {
    my ($pid) = @_;
    # Match the shell helper's fingerprint contract exactly. Locale or timezone
    # inherited from a caller must not make a live session look like PID reuse.
    local $ENV{LC_ALL} = "C";
    local $ENV{TZ} = "UTC";
    open my $handle, "-|", "/bin/ps", "-p", "$pid", "-o", "lstart="
        or return "";
    my $line = <$handle> // "";
    close $handle;
    $line =~ s/^\s+|\s+$//g;
    $line =~ s/\s+/ /g;
    return $line;
}

my $owner_pid = metadata_value($owner_path, "pid");
my $owner_token = metadata_value($owner_path, "token");
my $owner_start = metadata_value($owner_path, "process_start");

sub exact_owner_is_live {
    return 0 if $owner_pid !~ /^[1-9][0-9]*$/;
    return 0 if $owner_pid != getppid();
    return 0 if $owner_token ne $expected_token;
    return 0 if $owner_start eq "";
    return 0 if metadata_value($owner_path, "pid") ne $owner_pid;
    return 0 if metadata_value($owner_path, "token") ne $owner_token;
    return 0 if metadata_value($owner_path, "process_start") ne $owner_start;
    return process_start($owner_pid) eq $owner_start;
}

if (!exact_owner_is_live()) {
    unlink $pending_path;
    die "heavy-local session runner does not have the exact live recorded owner\n";
}

my $session_id = setsid();
if (!defined $session_id || $session_id != $$) {
    unlink $pending_path;
    die "heavy-local session runner could not create a dedicated session\n";
}
my $process_start = process_start($$);
if ($process_start eq "") {
    unlink $pending_path;
    die "heavy-local session runner could not fingerprint its process\n";
}

my $metadata_tmp = "$metadata_path.tmp.$$";
open my $metadata, ">", $metadata_tmp
    or die "could not create guarded child metadata: $!\n";
chmod 0600, $metadata_tmp
    or die "could not protect guarded child metadata: $!\n";
print {$metadata} "pid=$$\n";
print {$metadata} "process_start=$process_start\n";
print {$metadata} "pgid=$$\n";
print {$metadata} "session=$$\n";
close $metadata
    or die "could not publish guarded child metadata: $!\n";
rename $metadata_tmp, $metadata_path
    or die "could not install guarded child metadata: $!\n";

# The wrapper may receive a trapped signal after spawn but before it learns the
# child identity. Revalidate its exact PID/start/token immediately before commit
# so a reparented runner can never publish authority for an exited owner.
exact_owner_is_live()
    or die "heavy-local session runner lost its exact owner before commit\n";
# Atomically transition from pending to committed only after the complete
# metadata record is installed. Readers never infer commitment from absence.
rename $pending_path, $committed_path
    or die "could not complete guarded child handshake: $!\n";

# Commit alone is not permission to execute. Wait until the live exact owner has
# validated this session and published its capability token. If the wrapper
# exits first, getppid()/start/metadata revalidation fails and the body never
# starts; after authorization, the wrapper already has signal authority.
while (!-f $authorized_path) {
    exact_owner_is_live()
        or die "heavy-local session runner lost its exact owner before authorization\n";
    select undef, undef, undef, 0.01;
}
metadata_value($authorized_path, "token") eq $expected_token
    or die "heavy-local session runner received invalid owner authorization\n";
exact_owner_is_live() or die "heavy-local session runner lost its exact owner before exec\n";

exec {$program} $program, @ARGV;
die "could not exec guarded command $program: $!\n";
