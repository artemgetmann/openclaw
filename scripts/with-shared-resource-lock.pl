#!/usr/bin/env perl

use strict;
use warnings;

use Errno qw(EAGAIN EWOULDBLOCK);
use Fcntl qw(F_SETFD O_CREAT O_RDONLY O_RDWR :flock :mode);
use Time::HiRes qw(CLOCK_MONOTONIC clock_gettime sleep);

use constant MAX_WAIT_SECONDS => 86_400;
use constant REFUSED_STATUS   => 75;

sub usage {
    print STDERR <<'USAGE';
Usage:
  scripts/with-shared-resource-lock.pl --resource <name> [--also-resource <name>] [--label <text>] --check
  scripts/with-shared-resource-lock.pl --resource <name> --verify-inherited <fd> <capability>
  scripts/with-shared-resource-lock.pl --resource <name> [--also-resource <name>] [--label <text>] [--wait-seconds <seconds>] -- <command> [args...]

Serializes one named shared resource across this user's processes. Resource
names use lowercase letters, digits, dots, underscores, and hyphens, must start
and end with a letter or digit, and may contain at most 64 characters.

The label is sanitized diagnostic text only. It never establishes ownership.
The lock is released by the OS when the executed process exits or is killed.
USAGE
    exit 2;
}

sub diagnostic_label {
    my ($value) = @_;
    $value = 'unspecified' if !defined($value) || $value eq '';

    # Diagnostics must remain one bounded line. Do not let an arbitrary label
    # inject fields, terminal controls, or a large accidental environment value.
    $value =~ s/[^A-Za-z0-9._:\/@+ -]//g;
    $value = substr($value, 0, 160);
    return $value ne '' ? $value : 'unspecified';
}

sub refuse_busy {
    my ($resource, $label, $wait_seconds) = @_;
    print STDERR "SHARED_RESOURCE_LOCK_REFUSED resource=$resource label=$label reason=busy wait_seconds=$wait_seconds\n";
    exit REFUSED_STATUS;
}

my ($resource, $also_resource, $label, $wait_seconds, $check_only, @verify_inherited);
my %seen;
my @command;

# Parse explicitly so the command boundary is mandatory and guarded command
# options can never be mistaken for wrapper options.
while (@ARGV) {
    my $arg = shift @ARGV;
    if ($arg eq '--') {
        @command = @ARGV;
        @ARGV = ();
        last;
    }
    if ($arg eq '--help') {
        usage();
    }
    if ($arg eq '--check') {
        usage() if $seen{check}++;
        $check_only = 1;
        next;
    }
    if ($arg eq '--verify-inherited') {
        usage() if $seen{verify}++ || @ARGV < 2;
        @verify_inherited = (shift @ARGV, shift @ARGV);
        next;
    }
    if ($arg eq '--resource' || $arg eq '--also-resource' || $arg eq '--label' || $arg eq '--wait-seconds') {
        usage() if !@ARGV || $seen{$arg}++;
        my $value = shift @ARGV;
        if ($arg eq '--resource') {
            $resource = $value;
        } elsif ($arg eq '--also-resource') {
            $also_resource = $value;
        } elsif ($arg eq '--label') {
            $label = $value;
        } else {
            $wait_seconds = $value;
        }
        next;
    }
    usage();
}

usage() if !defined $resource;
usage() if $resource !~ /\A[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?\z/;
usage() if defined($also_resource) && $also_resource !~ /\A[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?\z/;
usage() if defined($also_resource) && $also_resource eq $resource;
usage() if @verify_inherited && (defined($also_resource) || $check_only || @command);

$wait_seconds = 0 if !defined $wait_seconds;
usage() if $wait_seconds !~ /\A(?:0|[1-9][0-9]*)\z/;
usage() if length($wait_seconds) > length(MAX_WAIT_SECONDS);
usage() if $wait_seconds > MAX_WAIT_SECONDS;
usage() if $check_only && ($wait_seconds != 0 || @command);
usage() if !$check_only && !@verify_inherited && !@command;
usage() if @verify_inherited && ($verify_inherited[0] !~ /\A[3-9][0-9]*\z/ || $verify_inherited[1] !~ /\A[0-9a-f]{64}\z/);

$label = diagnostic_label($label);

# /tmp is stable across interactive and launchd contexts, unlike TMPDIR. The
# UID-private directory keeps identical resource names isolated between users.
my $uid       = $<;
my $lock_root = "/tmp/openclaw-shared-resource-locks-$uid";
my $created_root = mkdir($lock_root, 0700);
if (!$created_root && !$!{EEXIST}) {
    die "SHARED_RESOURCE_LOCK_ERROR resource=$resource reason=lock_directory_create_failed\n";
}
chmod 0700, $lock_root if $created_root;

# Refuse a replaced, shared, or foreign lock directory. This makes the simple
# file open below safe from symlink substitution by another local user.
my @root_stat = lstat($lock_root);
if (!@root_stat || !S_ISDIR($root_stat[2]) || $root_stat[4] != $uid || ($root_stat[2] & 0077) != 0) {
    die "SHARED_RESOURCE_LOCK_ERROR resource=$resource reason=unsafe_lock_directory\n";
}

# Nested entrypoints must prove that the inherited descriptor is the exact lock
# file opened by the wrapper and carries its unguessable, per-acquisition
# capability. A resource name or an arbitrary open descriptor is not authority.
if (@verify_inherited) {
    my ($fd, $capability) = @verify_inherited;
    my $lock_path = "$lock_root/$resource.lock";
    open(my $inherited_fh, "+<&=$fd")
      or exit REFUSED_STATUS;
    sysopen(my $path_fh, $lock_path, O_RDONLY)
      or exit REFUSED_STATUS;
    my @fd_stat = stat($inherited_fh);
    my @path_stat = stat($path_fh);
    exit REFUSED_STATUS
      if !@fd_stat || !@path_stat || $fd_stat[0] != $path_stat[0] || $fd_stat[1] != $path_stat[1];
    sysseek($inherited_fh, 0, 0) or exit REFUSED_STATUS;
    my $stored = '';
    sysread($inherited_fh, $stored, 65) or exit REFUSED_STATUS;
    $stored =~ s/\s+\z//;
    exit REFUSED_STATUS if $stored ne $capability;
    exit 0;
}

my @resources = sort grep { defined $_ } ($resource, $also_resource);
my @lock_fhs;
my @capabilities;
my $acquired = 1;
for my $lock_resource (@resources) {
    my $lock_path = "$lock_root/$lock_resource.lock";
    sysopen(my $lock_fh, $lock_path, O_RDWR | O_CREAT, 0600)
      or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=lock_file_open_failed\n";
    my @file_stat = stat($lock_fh);
    if (!@file_stat || !S_ISREG($file_stat[2]) || $file_stat[4] != $uid || ($file_stat[2] & 0077) != 0) {
        die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=unsafe_lock_file\n";
    }
    if (!flock($lock_fh, LOCK_EX | LOCK_NB)) {
        die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=lock_operation_failed\n"
          if !$!{EAGAIN} && !$!{EWOULDBLOCK};
        $acquired = 0;
        last;
    }
    my $capability = '';
    sysopen(my $random_fh, '/dev/urandom', O_RDONLY)
      or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=random_open_failed\n";
    my $random = '';
    sysread($random_fh, $random, 32) == 32
      or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=random_read_failed\n";
    $capability = unpack('H*', $random);
    truncate($lock_fh, 0) or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=capability_write_failed\n";
    sysseek($lock_fh, 0, 0) or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=capability_write_failed\n";
    syswrite($lock_fh, "$capability\n") == 65
      or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=capability_write_failed\n";
    push @lock_fhs, $lock_fh;
    push @capabilities, $capability;
}

if (!$acquired && $wait_seconds > 0) {
    # Emit one bounded queue receipt. The sanitized label is diagnostic only;
    # kernel ownership still decides admission and process exit releases it.
    print STDERR "SHARED_RESOURCE_LOCK_WAITING resource=$resource label=$label wait_seconds=$wait_seconds\n";
    my $deadline = clock_gettime(CLOCK_MONOTONIC) + $wait_seconds;
    while (!$acquired) {
        my $remaining = $deadline - clock_gettime(CLOCK_MONOTONIC);
        last if $remaining <= 0;

        # A short bounded poll avoids platform-specific alarm interruption while
        # still admitting promptly when the current process exits.
        sleep($remaining < 0.05 ? $remaining : 0.05);
        # Do not launch after the deadline merely because the owner released
        # during the final sleep. The bounded transaction must either acquire
        # within its window or return the terminal contention receipt.
        last if clock_gettime(CLOCK_MONOTONIC) >= $deadline;
        @lock_fhs = ();
        @capabilities = ();
        $acquired = 1;
        for my $lock_resource (@resources) {
            my $lock_path = "$lock_root/$lock_resource.lock";
            sysopen(my $lock_fh, $lock_path, O_RDWR | O_CREAT, 0600)
              or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=lock_file_open_failed\n";
            if (!flock($lock_fh, LOCK_EX | LOCK_NB)) {
                die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=lock_operation_failed\n"
                  if !$!{EAGAIN} && !$!{EWOULDBLOCK};
                $acquired = 0;
                last;
            }
            my $capability = '';
            sysopen(my $random_fh, '/dev/urandom', O_RDONLY)
              or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=random_open_failed\n";
            my $random = '';
            sysread($random_fh, $random, 32) == 32
              or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=random_read_failed\n";
            $capability = unpack('H*', $random);
            truncate($lock_fh, 0) or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=capability_write_failed\n";
            sysseek($lock_fh, 0, 0) or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=capability_write_failed\n";
            syswrite($lock_fh, "$capability\n") == 65
              or die "SHARED_RESOURCE_LOCK_ERROR resource=$lock_resource reason=capability_write_failed\n";
            push @lock_fhs, $lock_fh;
            push @capabilities, $capability;
        }
    }
}

refuse_busy($resource, $label, $wait_seconds) if !$acquired;

if ($check_only) {
    print "SHARED_RESOURCE_LOCK_AVAILABLE resource=$resource label=$label\n";
    close($_) or die "SHARED_RESOURCE_LOCK_ERROR resource=$resource reason=lock_close_failed\n" for @lock_fhs;
    exit 0;
}

# Perl marks non-standard descriptors close-on-exec. Clear that flag so this
# exact process keeps the kernel lease when it becomes the guarded command.
for my $lock_fh (@lock_fhs) {
    fcntl($lock_fh, F_SETFD, 0)
      or die "SHARED_RESOURCE_LOCK_ERROR resource=$resource reason=lock_inheritance_failed\n";
}

# Nested canonical entrypoints can reuse only this exact resource. The open
# descriptor plus its per-acquisition capability is the ownership proof; the
# resource name alone cannot create a lease. This avoids chat IDs, PID files,
# and cleanup handoffs.
$ENV{OPENCLAW_SHARED_RESOURCE_LOCK} = join(',', @resources);
$ENV{OPENCLAW_SHARED_RESOURCE_LOCK_FD} = join(',', map { fileno($_) } @lock_fhs);
$ENV{OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY} = join(',', @capabilities);

exec { $command[0] } @command or do {
    print STDERR "SHARED_RESOURCE_LOCK_ERROR resource=$resource reason=command_exec_failed\n";
    exit 127;
};
