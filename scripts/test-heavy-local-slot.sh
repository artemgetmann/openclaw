#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/with-heavy-local-slot.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-heavy-local-slot-test.XXXXXX")"
FIXTURE_ROOT="$TMP_DIR/instrumented-root"
FIXTURE_WRAPPER="$FIXTURE_ROOT/scripts/with-heavy-local-slot.sh"
FIXTURE_DEDICATED_WRAPPER="$FIXTURE_ROOT/scripts/with-dedicated-agent-slot.sh"
SIGINT_RESET_LAUNCHER="$TMP_DIR/reset-sigint-and-exec.pl"
TERM_ATTRIBUTION_HOLDER="$TMP_DIR/term-attribution-holder.pl"
PERL_BIN=""
SUITE_PHASE="startup"
# $$ is inherited unchanged by Bash subshells. Capture BASHPID before any
# asynchronous launch so fixture output names the actual suite process.
SUITE_OS_PID="$BASHPID"

cleanup() {
  local background_pid=""

  # A failed assertion must not leave a holder or guarded fixture alive. Scope
  # cleanup to jobs started by this test shell, then remove only its temp root.
  while IFS= read -r background_pid; do
    [[ -n "$background_pid" ]] || continue
    kill -TERM "$background_pid" 2>/dev/null || true
  done < <(jobs -pr)
  wait 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

handle_suite_signal() {
  local signal_name="$1"
  local status="$2"

  # Name the interrupted phase before EXIT cleanup signals background fixtures.
  # Without this receipt, a holder's 143 and a TERM delivered to the suite are
  # indistinguishable at the outer wrapper boundary.
  printf 'FAIL: heavy-local slot suite received %s (suite PID %s, phase %s).\n' \
    "$signal_name" \
    "$$" \
    "$SUITE_PHASE" >&2
  trap - INT TERM HUP
  exit "$status"
}

trap 'handle_suite_signal INT 130' INT
trap 'handle_suite_signal TERM 143' TERM
trap 'handle_suite_signal HUP 129' HUP

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

wait_for_file() {
  local path="$1"
  local attempt=0

  while [[ ! -f "$path" && "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  [[ -f "$path" ]] || fail "timed out waiting for $path"
}

wait_for_absence() {
  local path="$1"
  local attempt=0

  while [[ -e "$path" && "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  [[ ! -e "$path" ]] || fail "timed out waiting for removal of $path"
}

wait_for_text() {
  local path="$1"
  local expected="$2"
  local attempt=0

  while [[ "$attempt" -lt 200 ]]; do
    if [[ -f "$path" ]] && grep -Fq "$expected" "$path"; then
      return 0
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  fail "timed out waiting for '$expected' in $path"
}

assert_one_line() {
  local path="$1"
  local expected="$2"
  local count=0

  count="$(grep -Fc "$expected" "$path" || true)"
  [[ "$count" -eq 1 ]] || fail "expected one '$expected' line in $path, found $count"
}

wait_for_dead_pid() {
  local pid="$1"
  local attempt=0

  while kill -0 "$pid" 2>/dev/null && [[ "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  ! kill -0 "$pid" 2>/dev/null || fail "PID $pid remained alive"
}

wait_for_dead_group() {
  local pgid="$1"
  local attempt=0

  while kill -0 -- "-$pgid" 2>/dev/null && [[ "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  ! kill -0 -- "-$pgid" 2>/dev/null || fail "process group $pgid remained alive"
}

write_healthy_samples() {
  local path="$1"
  local sample=0

  : >"$path"
  while [[ "$sample" -lt 20 ]]; do
    printf 'healthy\n' >>"$path"
    sample=$((sample + 1))
  done
}

create_instrumented_runtime() {
  local fixture_helper="$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh"
  local fixture_helper_tmp="$fixture_helper.tmp"
  local fixture_health_hook="$FIXTURE_ROOT/scripts/lib/heavy-local-slot-health-fixture.sh"
  local fixture_hotfix="$FIXTURE_ROOT/scripts/ship-jarvis-hotfix.sh"
  local fixture_lifecycle_command="$FIXTURE_ROOT/scripts/gateway-lifecycle-command.sh"
  local fixture_runner="$FIXTURE_ROOT/scripts/lib/heavy-local-slot-runner.pl"
  local fixture_runner_tmp="$fixture_runner.tmp"
  local fixture_wrapper_tmp="$FIXTURE_WRAPPER.tmp"
  local injected_hook_count=0
  local injected_runner_hook_count=0
  local injected_session_hook_count=0
  local injected_stop_receipt_count=0
  local injected_transient_identity_hook_count=0

  mkdir -p "$FIXTURE_ROOT/scripts/lib"
  cp "$ROOT_DIR/scripts/lib/heavy-local-slot.sh" "$fixture_helper"
  cp "$ROOT_DIR/scripts/with-dedicated-agent-slot.sh" "$FIXTURE_DEDICATED_WRAPPER"
  cp \
    "$ROOT_DIR/scripts/lib/jarvis-release-lock.sh" \
    "$FIXTURE_ROOT/scripts/lib/jarvis-release-lock.sh"

  # Force one disposable post-commit identity read to report the exact
  # transient ambiguity produced when a very fast child exits between probes.
  # Production has no environment hook; this exists only in the copied helper.
  /usr/bin/awk '
    $0 == "openclaw_heavy_local_slot_child_group_status() {" {
      print
      print "  if [[ -n \"${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_TRANSIENT_IDENTITY_FILE:-}\" &&"
      print "    ! -e \"$OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_TRANSIENT_IDENTITY_FILE\" ]]; then"
      print "    : >\"$OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_TRANSIENT_IDENTITY_FILE\""
      print "    return 2"
      print "  fi"
      next
    }
    { print }
  ' "$fixture_helper" >"$fixture_helper_tmp"
  /bin/mv "$fixture_helper_tmp" "$fixture_helper"

  # Pause only the disposable runner immediately after metadata publication and
  # before the atomic commit transition. This makes the formerly racy state
  # deterministic without putting a fixture hook in production code.
  /usr/bin/awk '
    $0 == "exact_owner_is_live()" {
      print "if (defined $ENV{OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_READY_FILE}) {"
      print "    my $fixture_ready = $ENV{OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_READY_FILE};"
      print "    my $fixture_release = $ENV{OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_RELEASE_FILE} // \"\";"
      print "    $fixture_release ne \"\" or die \"fixture handshake release path is missing\\n\";"
      print "    open my $fixture_ready_handle, \">\", $fixture_ready or die \"could not publish fixture handshake readiness: $!\\n\";"
      print "    close $fixture_ready_handle or die \"could not close fixture handshake readiness: $!\\n\";"
      print "    while (!-e $fixture_release) { select undef, undef, undef, 0.01; }"
      print "}"
    }
    $0 == "    print $result;" {
      print "    if (defined $ENV{OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_SESSION_MISMATCH}) {"
      print "        $result =~ s/^session=[1-9][0-9]*$/session=99999999/m;"
      print "    }"
    }
    { print }
  ' "$ROOT_DIR/scripts/lib/heavy-local-slot-runner.pl" >"$fixture_runner_tmp"
  /bin/mv "$fixture_runner_tmp" "$fixture_runner"

  # Only the disposable copy accepts a private path. Canonical scripts always
  # source the production helper, whose lock identity has no ambient override.
  cat >>"$fixture_helper" <<'EOF'

openclaw_heavy_local_slot_default_path() {
  [[ -n "${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH:-}" ]] || return 1
  printf '%s\n' "$OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH"
}

openclaw_heavy_local_slot_after_mkdir() {
  if [[ "${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_BLOCK_OWNER_WRITE:-0}" == "1" ]]; then
    OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR="fixture_before_owner_write"
    return 1
  fi
}
EOF

  # Policy validation resolves this exact fixture-root entrypoint. Its body is
  # intentionally tiny: the test is for admission semantics, not deployment.
  cat >"$fixture_hotfix" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

marker="$1"
sleep 0.2
: >"$marker"
EOF
  chmod +x "$fixture_hotfix"

  # The production lifecycle command validates the real Node entrypoint and
  # launchd target. This disposable counterpart keeps the wrapper policy proof
  # focused: only the canonical path and explicit `cli` mode can reach work.
  cat >"$fixture_lifecycle_command" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "cli" ]] || exit 75
shift
[[ "${1:-}" == "--" ]] || exit 75
shift
exec "$@"
EOF
  chmod +x "$fixture_lifecycle_command"

  cat >"$fixture_health_hook" <<'EOF'
probe_dedicated_jarvis() {
  # The copied wrapper must never inspect the live Jarvis service. Individual
  # fixture samples below own every healthy and unhealthy identity transition.
  printf '%s' 'ok|4242'
}

host_health_reason() {
  local required_cpu_idle="$1"
  local require_jarvis_health="$2"
  local sample_phase="${4:-unknown}"
  local test_health_file="${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE:-}"
  local test_ready_file="${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE:-}"
  local test_health_sample="" test_health_tmp="" test_cpu_idle=""

  # Runtime-stop tests must first prove that their complete child tree exists.
  # Until that fixture-owned marker appears, report healthy without consuming a
  # sample. This removes scheduler timing from the two-strike assertion.
  if [[ -n "$test_ready_file" && ! -f "$test_ready_file" ]]; then
    return 0
  fi

  if [[ -s "$test_health_file" ]]; then
    test_health_sample="$(/usr/bin/head -n 1 "$test_health_file")"
    test_health_tmp="${test_health_file}.tmp.$$"
    /usr/bin/tail -n +2 "$test_health_file" >"$test_health_tmp"
    /bin/mv "$test_health_tmp" "$test_health_file"
  fi
  # CPU samples exercise the real policy split while keeping production free of
  # ambient health hooks. Dedicated mode records the same observation and then
  # continues to every non-CPU fixture gate below.
  if [[ "$test_health_sample" =~ ^cpu-([0-9]|[1-9][0-9]|100)$ ]]; then
    test_cpu_idle="${BASH_REMATCH[1]}"
    if [[ "$cpu_policy" == "dedicated-agent" ]]; then
      printf 'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=dedicated-agent phase=%s status=observed enforcement=telemetry_only metric=cpu_idle_percent observed=%s threshold=none unit=percent\n' \
        "$sample_phase" "$test_cpu_idle" >&2
    else
      printf 'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=standard phase=%s status=%s enforcement=threshold metric=cpu_idle_percent observed=%s threshold=%s unit=percent\n' \
        "$sample_phase" \
        "$([[ "$test_cpu_idle" -lt "$required_cpu_idle" ]] && printf pressure || printf healthy)" \
        "$test_cpu_idle" \
        "$required_cpu_idle" >&2
      if [[ "$test_cpu_idle" -lt "$required_cpu_idle" ]]; then
        printf 'host_unhealthy|cpu_pressure|CPU idle is %s%% (minimum %s%%)|metric=cpu_idle_percent observed=%s threshold=%s unit=percent' \
          "$test_cpu_idle" "$required_cpu_idle" "$test_cpu_idle" "$required_cpu_idle"
      fi
    fi
  elif [[ "$test_health_sample" == "memory-low" ]]; then
    printf '%s' \
      'host_unhealthy|memory_pressure|memory headroom is 10% (minimum 25%)|metric=memory_free_percent observed=10 threshold=25 unit=percent'
  elif [[ "$test_health_sample" == "jarvis-unhealthy" ]]; then
    if [[ "$require_jarvis_health" == "1" ]]; then
      printf '%s' \
        'host_unhealthy|jarvis_unhealthy|managed Jarvis health check failed|metric=jarvis_health observed=unhealthy expected=healthy'
    fi
  elif [[ "$test_health_sample" == "memory-warning-stable" ]]; then
    printf 'HEAVY_LOCAL_RESOURCE_TELEMETRY cpu_policy=dedicated-agent phase=%s memory_pressure=warn memory_pressure_level=2 swap_used_kib=1024 swap_free_kib=2048 pageouts_total=10 swapouts_total=5 runtime_swapout_growth_pages=0 runtime_pageout_interval_pages=0 runtime_swapout_interval_pages=0 paging_status=observed paging_enforcement=warn_active_paging_two_strike thermal_state=normal next_action=observe_pageout_swapout_trend\n' \
      "$sample_phase" >&2
  elif [[ "$test_health_sample" == "memory-active-paging" ]]; then
    printf '%s' \
      'host_unhealthy|active_paging_growth|yellow memory pressure has active pageout and swapout growth|metric=active_paging_growth pageouts_delta=145 swapouts_delta=10032 threshold=stable unit=pages'
  elif [[ "$test_health_sample" == "memory-critical" ]]; then
    printf 'HEAVY_LOCAL_RESOURCE_TELEMETRY cpu_policy=dedicated-agent phase=%s memory_pressure=critical memory_pressure_level=4 swap_used_kib=1024 swap_free_kib=2048 pageouts_total=10 swapouts_total=5 runtime_swapout_growth_pages=0 runtime_pageout_interval_pages=0 runtime_swapout_interval_pages=0 paging_status=observed paging_enforcement=warn_active_paging_two_strike thermal_state=normal next_action=observe_pageout_swapout_trend\n' \
      "$sample_phase" >&2
    printf '%s' \
      'host_unhealthy|memory_pressure_state|macOS memory pressure is critical|metric=memory_pressure_state observed=critical expected=normal'
  elif [[ "$test_health_sample" == "thermal-warning" ]]; then
    printf 'HEAVY_LOCAL_RESOURCE_TELEMETRY cpu_policy=dedicated-agent phase=%s memory_pressure=normal memory_pressure_level=1 swap_used_kib=1024 swap_free_kib=2048 pageouts_total=10 swapouts_total=5 runtime_swapout_growth_pages=0 runtime_pageout_interval_pages=0 runtime_swapout_interval_pages=0 paging_status=observed paging_enforcement=warn_active_paging_two_strike thermal_state=pressure next_action=observe_pageout_swapout_trend\n' \
      "$sample_phase" >&2
    printf '%s' \
      'host_unhealthy|thermal_pressure|macOS reports thermal or performance pressure|metric=thermal_pressure observed=pressure expected=normal'
  elif [[ "$test_health_sample" == "jarvis-identity-mismatch" ]]; then
    printf '%s' \
      'host_unhealthy|jarvis_listener_mismatch|managed Jarvis LaunchAgent PID does not exclusively own port 18789|metric=jarvis_listener_pid observed=5252 expected=4242 listener_count=1'
  elif [[ "$test_health_sample" == "jarvis-identity-changed" ]]; then
    printf '%s' \
      'host_unhealthy|jarvis_identity_changed|managed Jarvis PID changed during guarded work|metric=jarvis_launch_pid observed=5252 expected=4242'
  elif [[ "$test_health_sample" == "jarvis-latency-timeout" ]]; then
    printf '%s' \
      'host_unhealthy|jarvis_http_failed|managed Jarvis health check failed|metric=jarvis_http_health observed=request_failed expected=http_200'
  elif [[ "$test_health_sample" =~ ^jarvis-http-(404|503)$ ]]; then
    printf 'host_unhealthy|jarvis_http_failed|managed Jarvis health endpoint returned HTTP %s|metric=jarvis_http_status observed=%s expected=200' \
      "${BASH_REMATCH[1]}" \
      "${BASH_REMATCH[1]}"
  elif [[ "$test_health_sample" == "resource-unavailable" ]]; then
    printf '%s' \
      'guard_internal|paging_measurement_failed|could not measure swap and pageout counters|metric=paging_trend status=unavailable'
  elif [[ "$test_health_sample" == "fanout-unavailable" ]]; then
    printf '%s' \
      'guard_internal|fanout_measurement_failed|could not measure the guarded process group|metric=guarded_group_fanout status=unavailable'
  elif [[ "$test_health_sample" == "resource-advisory" ]]; then
    printf 'HEAVY_LOCAL_RESOURCE_TELEMETRY cpu_policy=dedicated-agent phase=%s memory_pressure=normal memory_pressure_level=1 swap_used_kib=2048 swap_free_kib=1024 pageouts_total=20 swapouts_total=10 runtime_swapout_growth_pages=0 runtime_pageout_interval_pages=0 runtime_swapout_interval_pages=0 paging_status=observed paging_enforcement=warn_active_paging_two_strike thermal_state=normal next_action=observe_pageout_swapout_trend\n' \
      "$sample_phase" >&2
  elif [[ "$test_health_sample" == "fanout-observed" ]]; then
    printf '%s\n' \
      'HEAVY_LOCAL_GROUP_TELEMETRY cpu_policy=dedicated-agent phase=runtime pgid=4242 process_count=3 rss_kib=4096 enforcement=single_guarded_group fanout_status=observed rss_status=observed next_action=inspect_guarded_group_growth_if_sustained' >&2
  elif [[ "$test_health_sample" == "guard-internal" ]]; then
    printf '%s' \
      'guard_internal|fixture_measurement_failed|synthetic measurement backend failed|metric=fixture status=unavailable'
  elif [[ "$test_health_sample" == "disk-low" ]]; then
    printf '%s' \
      'host_unhealthy|disk_pressure|disk availability is 25000000 KiB (minimum 26214400 KiB)|metric=disk_available_kib observed=25000000 threshold=26214400 unit=KiB'
  elif [[ "$test_health_sample" == "disk-unavailable" ]]; then
    printf '%s' \
      'guard_internal|disk_measurement_failed|could not measure disk headroom|metric=disk_available_kib status=unavailable'
  elif [[ "$test_health_sample" == "disk-warning" ]]; then
    printf '%s\n' \
      'HEAVY_LOCAL_DISK_REPORT status=warning observed_kib=34000000 report_below_kib=36700160 hard_floor_kib=26214400 owner=disk-warning phase=admission outcome=advisory next_action=reclaim_owner_attributed_space_before_hard_floor' >&2
  elif [[ -n "$test_health_sample" && "$test_health_sample" != "healthy" ]]; then
    printf 'host_unhealthy|fixture_host_pressure|%s|metric=fixture observed=unhealthy' \
      "$test_health_sample"
  fi
}
EOF

  # Instrument only the copied wrapper. The checked-in wrapper retains fixed
  # policy constants and has no hook path or fake-health switch.
  /usr/bin/awk '
    $0 == "readonly MONITOR_INTERVAL_SECONDS=15" {
      print "readonly MONITOR_INTERVAL_SECONDS=0.05"
      next
    }
    $0 == "readonly WAIT_POLL_SECONDS=5" {
      print "readonly WAIT_POLL_SECONDS=1"
      next
    }
    $0 == "readonly TASK_DISK_RECEIPT_THRESHOLD_KIB=$((1024 * 1024))" {
      print "readonly TASK_DISK_RECEIPT_THRESHOLD_KIB=1"
      next
    }
    $0 == "  preflight_result=$(host_health_reason \"$PREFLIGHT_MIN_CPU_IDLE_PERCENT\" \"$require_jarvis_health\" 1 preflight)" {
      print "source \"${ROOT_DIR}/scripts/lib/heavy-local-slot-health-fixture.sh\""
    }
    $0 == "  kill -TERM -- \"-$child_pgid\" 2>/dev/null || true" {
      # Attribute only real fixture group signals. This copied-wrapper receipt
      # keeps production output unchanged and distinguishes internal cleanup
      # from an external TERM delivered directly to the guarded child.
      print "  printf '\''FIXTURE: stop_guarded_child sender=%s owner=%s child=%s pgid=%s.\\n'\'' \\"
      print "    \"${FUNCNAME[1]:-unknown}\" \"$$\" \"${child_pid:-unknown}\" \"${child_pgid:-unknown}\" >&2"
    }
    { print }
  ' "$WRAPPER" >"$fixture_wrapper_tmp"
  /bin/mv "$fixture_wrapper_tmp" "$FIXTURE_WRAPPER"
  chmod +x "$FIXTURE_WRAPPER"

  # Fail immediately if a production refactor moved the injection anchor. A
  # silently uninjected fixture would sample the real host and make this suite
  # nondeterministic instead of proving the intended health transitions.
  injected_hook_count="$(
    grep -Fc 'source "${ROOT_DIR}/scripts/lib/heavy-local-slot-health-fixture.sh"' \
      "$FIXTURE_WRAPPER" || true
  )"
  [[ "$injected_hook_count" -eq 1 ]] ||
    fail "instrumented wrapper contains $injected_hook_count health hooks instead of 1"
  injected_stop_receipt_count="$(
    grep -Fc 'FIXTURE: stop_guarded_child sender=' "$FIXTURE_WRAPPER" || true
  )"
  [[ "$injected_stop_receipt_count" -eq 1 ]] ||
    fail "instrumented wrapper contains $injected_stop_receipt_count stop receipts instead of 1"
  injected_runner_hook_count="$(
    grep -Fc 'OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_READY_FILE' \
      "$fixture_runner" || true
  )"
  [[ "$injected_runner_hook_count" -eq 2 ]] ||
    fail "instrumented runner contains $injected_runner_hook_count handshake hook references instead of 2"
  injected_session_hook_count="$(
    grep -Fc 'OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_SESSION_MISMATCH' \
      "$fixture_runner" || true
  )"
  [[ "$injected_session_hook_count" -eq 1 ]] ||
    fail "instrumented runner contains $injected_session_hook_count session hooks instead of 1"
  injected_transient_identity_hook_count="$(
    grep -Fc 'OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_TRANSIENT_IDENTITY_FILE' \
      "$fixture_helper" || true
  )"
  [[ "$injected_transient_identity_hook_count" -eq 3 ]] ||
    fail "instrumented helper contains $injected_transient_identity_hook_count transient identity hooks instead of 3"
}

create_sigint_reset_launcher() {
  # Bash deliberately cannot trap SIGINT when it started with that signal
  # ignored. Perl is already used by canonical repo scripts and exposes the
  # underlying sigaction reset before exec, so the copied wrapper receives the
  # same default-at-startup disposition as a real foreground invocation.
  PERL_BIN="$(command -v perl || true)"
  [[ -n "$PERL_BIN" && -x "$PERL_BIN" ]] ||
    fail "signal proof requires Perl to reset inherited SIGINT; refusing to skip INT"

  cat >"$SIGINT_RESET_LAUNCHER" <<'EOF'
#!/usr/bin/env perl
use strict;
use warnings;

@ARGV or die "reset-sigint-and-exec requires a command\n";
$SIG{INT} = 'DEFAULT';
my $program = shift @ARGV;
exec {$program} $program, @ARGV;
die "could not exec $program: $!\n";
EOF
}

create_term_attribution_holder() {
  # A conventional shell trap proves only the signal number. SA_SIGINFO also
  # exposes the sender PID for user-originated signals, which lets one repro
  # distinguish suite cleanup, wrapper supervision, and an external process.
  cat >"$TERM_ATTRIBUTION_HOLDER" <<'EOF'
#!/usr/bin/env perl
use strict;
use warnings;
use POSIX qw(SIGTERM SA_SIGINFO sigaction);

@ARGV == 3
    or die "usage: term-attribution-holder.pl <ready> <release> <suite-pid>\n";
my ($ready_path, $release_path, $suite_pid) = @ARGV;

my $term_action = POSIX::SigAction->new(
    sub {
        my ($signal_name, $signal_info, $raw_signal_info) = @_;
        my ($raw_code, $raw_pid, $raw_uid);

        # This macOS Perl does not populate the optional pid/uid/code hash
        # fields. Darwin siginfo_t begins with five consecutive 32-bit values:
        # signo, errno, code, sender pid, and sender uid. Decode the raw third
        # callback argument using that SDK-defined layout.
        if ($^O eq "darwin" &&
            defined $raw_signal_info &&
            length($raw_signal_info) >= 20) {
            my ($raw_signo, $raw_errno);
            ($raw_signo, $raw_errno, $raw_code, $raw_pid, $raw_uid) =
                unpack "l5", substr($raw_signal_info, 0, 20);
        }
        my $sender_pid =
            defined $signal_info && defined $signal_info->{pid}
            ? $signal_info->{pid}
            : defined $raw_pid
                ? $raw_pid
                : "unknown";
        my $sender_uid =
            defined $signal_info && defined $signal_info->{uid}
            ? $signal_info->{uid}
            : defined $raw_uid
                ? $raw_uid
                : "unknown";
        my $signal_code =
            defined $signal_info && defined $signal_info->{code}
            ? $signal_info->{code}
            : defined $raw_code
                ? $raw_code
                : "unknown";
        my $holder_pgid = getpgrp(0);

        # Exit with the same observable status as SIGTERM after recording the
        # kernel attribution. This is a disposable fixture, not runner policy.
        print STDERR
            "FIXTURE: guarded holder received $signal_name from PID $sender_pid ",
            "UID $sender_uid code $signal_code (holder PID $$, PGID $holder_pgid, ",
            "wrapper PID ", getppid(), ", suite PID $suite_pid).\n";
        exit 143;
    },
    POSIX::SigSet->new(),
    SA_SIGINFO,
);
# Deferred handling permits normal Perl I/O in the diagnostic callback while
# retaining the siginfo captured by the low-level handler.
$term_action->safe(1);
defined sigaction(SIGTERM, $term_action)
    or die "could not install TERM attribution handler\n";

open my $ready, ">", $ready_path
    or die "could not publish holder readiness: $!\n";
close $ready or die "could not close holder readiness: $!\n";

while (!-e $release_path) {
    select undef, undef, undef, 0.05;
}
EOF
}

run_test_wrapper() {
  local lock_path="$1"
  local health_path="$2"
  local label="$3"
  local ready_path="${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE:-}"
  shift 3

  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE="$ready_path" \
    "$FIXTURE_WRAPPER" --label "$label" -- "$@"
}

test_production_has_no_ambient_test_bypass() {
  local production_script=""

  # The checked-in helper and wrapper must never learn fixture environment
  # names. Private locks and synthetic health exist only in the disposable
  # copies created above, so canonical commands cannot opt into them.
  for production_script in \
    "$ROOT_DIR/scripts/lib/heavy-local-slot.sh" \
    "$ROOT_DIR/scripts/lib/heavy-local-slot-runner.pl" \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh"; do
    if grep -Eq \
      'OPENCLAW_HEAVY_LOCAL_SLOT_(TEST|FIXTURE)|OPENCLAW_HEAVY_LOCAL_SLOT_TESTING' \
      "$production_script"; then
      fail "$production_script exposes an ambient test bypass"
    fi
  done

  for production_script in \
    OPENCLAW_FLEET_MIN_MEMORY_FREE_PERCENT \
    OPENCLAW_FLEET_MIN_CPU_IDLE_PERCENT \
    OPENCLAW_FLEET_RUNTIME_MIN_CPU_IDLE_PERCENT \
    OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS; do
    if grep -Fq "$production_script" "$ROOT_DIR/scripts/with-heavy-local-slot.sh"; then
      fail "production wrapper exposes ambient health tuning via $production_script"
    fi
  done
  grep -Fq 'readonly MIN_MEMORY_FREE_PERCENT=25' "$WRAPPER" ||
    fail "production memory threshold is not fixed at 25%"
  grep -Fq 'readonly PREFLIGHT_MIN_CPU_IDLE_PERCENT=35' "$WRAPPER" ||
    fail "production preflight CPU threshold is not fixed at 35%"
  grep -Fq 'readonly RUNTIME_MIN_CPU_IDLE_PERCENT=20' "$WRAPPER" ||
    fail "production runtime CPU threshold is not fixed at 20%"
  grep -Fq 'readonly MIN_DISK_FREE_KIB=$((25 * 1024 * 1024))' "$WRAPPER" ||
    fail "production disk floor is not fixed at 25 GiB"
  grep -Fq 'readonly DISK_REPORT_BELOW_KIB=$((35 * 1024 * 1024))' "$WRAPPER" ||
    fail "production disk report threshold is not fixed at 35 GiB"
  grep -Fq 'readonly TASK_DISK_RECEIPT_THRESHOLD_KIB=$((1024 * 1024))' "$WRAPPER" ||
    fail "production task disk receipt threshold is not fixed at 1 GiB"
  grep -Fq 'readonly MONITOR_INTERVAL_SECONDS=15' "$WRAPPER" ||
    fail "production monitor interval is not fixed at 15 seconds"
  grep -Fq 'readonly UNHEALTHY_STRIKES_BEFORE_STOP=2' "$WRAPPER" ||
    fail "production stop rule is not fixed at two unhealthy samples"
  grep -Fq 'readonly HOST_HEALTH_HTTP_TIMEOUT_SECONDS=3' "$WRAPPER" ||
    fail "production health timeout is not fixed at three seconds"
  grep -Fq "cpu_policy='dedicated-agent'" "$WRAPPER" ||
    fail "canonical heavy transactions do not default to dedicated-agent CPU policy"
  if grep -Fq -- '--cpu-policy standard' "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"; then
    fail "self-guarded build or release callers silently force shared CPU policy"
  fi
  grep -Fq '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level' "$WRAPPER" ||
    fail "dedicated resource policy does not read the macOS memory-pressure state"
  grep -Fq '/usr/sbin/sysctl -n vm.swapusage' "$WRAPPER" ||
    fail "dedicated resource policy does not measure swap usage"
  grep -Fq '/usr/bin/vm_stat' "$WRAPPER" ||
    fail "dedicated resource policy does not measure pageout counters"
  grep -Fq '/usr/bin/pmset -g therm' "$WRAPPER" ||
    fail "dedicated resource policy does not measure thermal pressure"
  grep -Fq '/usr/sbin/lsof -nP -tiTCP:18789 -sTCP:LISTEN' "$WRAPPER" ||
    fail "dedicated resource policy does not bind Jarvis to its listener PID"
  grep -Fq -- "-w '%{http_code}|%{time_total}'" "$WRAPPER" ||
    fail "dedicated resource policy does not measure Jarvis HTTP latency"
  grep -Fq 'HEAVY_LOCAL_GROUP_TELEMETRY' "$WRAPPER" ||
    fail "dedicated resource policy does not expose guarded-group fanout"
  if grep -Eq 'MIN_SWAP_FREE|MAX_SWAP|MAX_PAGEOUT|MAX_FANOUT' "$WRAPPER"; then
    fail "production wrapper invented an unevidenced paging or fanout threshold"
  fi
  pass "production wrapper exposes no ambient bypass or health tuning"
}

test_cpu_policy_is_explicit_narrow_and_receipted() {
  local default_lock="$TMP_DIR/cpu-policy-default.lock"
  local shared_lock="$TMP_DIR/cpu-policy-shared.lock"
  local dedicated_lock="$TMP_DIR/cpu-policy-dedicated.lock"
  local runtime_lock="$TMP_DIR/cpu-policy-runtime.lock"
  local unknown_lock="$TMP_DIR/cpu-policy-unknown.lock"
  local non_cpu_lock="$TMP_DIR/cpu-policy-non-cpu.lock"
  local non_cpu_runtime_lock="$TMP_DIR/cpu-policy-non-cpu-runtime.lock"
  local health_path="$TMP_DIR/cpu-policy.health"
  local marker="$TMP_DIR/cpu-policy.marker"
  local output="$TMP_DIR/cpu-policy.out"
  local status=0

  # Agent-owned work is the host default. Even at 0% idle, an unflagged
  # canonical transaction must run while keeping CPU telemetry visible. An
  # ambient value remains inert so callers cannot change policy implicitly.
  printf 'cpu-0\n' >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$default_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_HEAVY_LOCAL_CPU_POLICY=standard \
    "$FIXTURE_WRAPPER" --label "cpu-default" -- touch "$marker" >"$output" 2>&1
  [[ -e "$marker" ]] || fail "default dedicated CPU policy stopped work at 0% idle"
  grep -Fq \
    'HEAVY_LOCAL_SLOT_RECEIPT status=granted policy=standard cpu_policy=dedicated-agent owner=cpu-default' \
    "$output" || fail "default grant omitted dedicated-agent CPU policy"
  grep -Fq \
    'cpu_policy=dedicated-agent phase=preflight status=observed enforcement=telemetry_only metric=cpu_idle_percent observed=0 threshold=none' \
    "$output" || fail "default CPU policy omitted zero-idle telemetry"
  [[ ! -e "$default_lock" ]] || fail "default dedicated CPU policy leaked its lease"
  /bin/rm -f "$marker"

  # Artem can explicitly restore shared/interactive headroom. The compatibility
  # name `standard` retains the established 35% admission and 20% runtime floors.
  printf 'cpu-33\n' >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$shared_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy standard \
      --label "cpu-shared-interactive" \
      -- touch "$marker" >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "shared CPU policy admitted 33% idle with status $status"
  [[ ! -e "$marker" ]] || fail "shared CPU policy ran work below its admission floor"
  grep -Fq 'code=cpu_pressure metric=cpu_idle_percent observed=33 threshold=35' "$output" ||
    fail "shared CPU refusal lost its 35% threshold receipt"
  grep -Fq 'cpu_policy=standard phase=preflight status=pressure enforcement=threshold' "$output" ||
    fail "shared CPU policy omitted its structured sample"

  # The explicit dedicated transaction admits 0% idle and continues sampling at
  # runtime. The command must complete even after repeated zero-idle samples.
  {
    printf 'cpu-0\n'
    printf 'cpu-0\n'
    printf 'cpu-0\n'
    printf 'cpu-0\n'
  } >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$dedicated_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "cpu-dedicated" \
      -- bash -c 'sleep 0.2; touch "$1"' _ "$marker" >"$output" 2>&1
  [[ -e "$marker" ]] || fail "dedicated CPU policy stopped work at 0% idle"
  grep -Fq \
    'HEAVY_LOCAL_SLOT_RECEIPT status=granted policy=standard cpu_policy=dedicated-agent owner=cpu-dedicated' \
    "$output" || fail "dedicated grant omitted its selected policy"
  grep -Fq \
    'cpu_policy=dedicated-agent phase=preflight status=observed enforcement=telemetry_only metric=cpu_idle_percent observed=0 threshold=none' \
    "$output" || fail "dedicated preflight omitted zero-idle telemetry"
  grep -Fq \
    'cpu_policy=dedicated-agent phase=runtime status=observed enforcement=telemetry_only metric=cpu_idle_percent observed=0 threshold=none' \
    "$output" || fail "dedicated runtime omitted zero-idle telemetry"
  [[ ! -e "$dedicated_lock" ]] || fail "dedicated CPU policy leaked its lease"
  /bin/rm -f "$marker"

  # Standard runtime enforcement remains two-strike and kills work below 20%.
  {
    printf 'cpu-100\n'
    printf 'cpu-0\n'
    printf 'cpu-0\n'
  } >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$runtime_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy standard \
      --label "cpu-standard-runtime" \
      -- bash -c 'sleep 1; touch "$1"' _ "$marker" >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "standard runtime CPU pressure returned $status instead of 75"
  [[ ! -e "$marker" ]] || fail "standard runtime CPU pressure failed to stop work"
  grep -Fq 'code=cpu_pressure metric=cpu_idle_percent observed=0 threshold=20' "$output" ||
    fail "standard runtime CPU stop lost its 20% threshold receipt"
  [[ ! -e "$runtime_lock" ]] || fail "standard runtime CPU stop leaked its lease"

  # Unknown policy values fail before lease acquisition or command execution.
  printf 'cpu-100\n' >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$unknown_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agents \
      --label "cpu-unknown" \
      -- touch "$marker" >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "unknown CPU policy returned $status instead of 75"
  [[ ! -e "$marker" && ! -e "$unknown_lock" ]] ||
    fail "unknown CPU policy acquired a lease or ran work"
  grep -Fq 'class=guard_internal code=unknown_cpu_policy cpu_policy=dedicated-agents' "$output" ||
    fail "unknown CPU policy omitted its fail-closed receipt"

  # Dedicated CPU mode does not exempt any preflight host-health check. Exercise
  # memory, disk, and Jarvis independently so a future broad exemption cannot
  # hide behind one representative failure.
  local non_cpu_sample="" non_cpu_code=""
  for non_cpu_sample in memory-low disk-low jarvis-unhealthy; do
    case "$non_cpu_sample" in
      memory-low) non_cpu_code=memory_pressure ;;
      disk-low) non_cpu_code=disk_pressure ;;
      jarvis-unhealthy) non_cpu_code=jarvis_unhealthy ;;
    esac
    printf '%s\n' "$non_cpu_sample" >"$health_path"
    set +e
    OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$non_cpu_lock" \
    OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
      "$FIXTURE_WRAPPER" \
        --cpu-policy dedicated-agent \
        --label "cpu-dedicated-${non_cpu_sample}" \
        -- touch "$marker" >"$output" 2>&1
    status=$?
    set -e
    [[ "$status" -eq 75 ]] ||
      fail "dedicated CPU policy ignored $non_cpu_sample with status $status"
    [[ ! -e "$marker" && ! -e "$non_cpu_lock" ]] ||
      fail "dedicated CPU policy bypassed $non_cpu_sample or leaked its lease"
    grep -Fq "class=host_unhealthy code=${non_cpu_code}" "$output" ||
      fail "dedicated CPU policy lost the $non_cpu_sample refusal"
  done

  # The same boundary holds after admission: two memory-pressure samples stop
  # the in-flight command and preserve the canonical cleanup/exit-75 contract.
  {
    printf 'cpu-100\n'
    printf 'memory-low\n'
    printf 'memory-low\n'
  } >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$non_cpu_runtime_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "cpu-dedicated-runtime-memory" \
      -- bash -c 'sleep 1; touch "$1"' _ "$marker" >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] ||
    fail "dedicated CPU runtime ignored repeated memory pressure with status $status"
  [[ ! -e "$marker" && ! -e "$non_cpu_runtime_lock" ]] ||
    fail "dedicated CPU runtime failed memory cleanup or leaked its lease"
  grep -Fq 'code=memory_pressure metric=memory_free_percent observed=10 threshold=25' "$output" ||
    fail "dedicated CPU runtime lost its memory stop receipt"
  pass "CPU policy defaults dedicated, keeps shared headroom explicit, and remains narrow"
}

test_dedicated_entrypoint_cannot_fall_back_to_standard_cpu_gates() {
  local lock_path="$TMP_DIR/dedicated-entrypoint.lock"
  local health_path="$TMP_DIR/dedicated-entrypoint.health"
  local marker="$TMP_DIR/dedicated-entrypoint.marker"
  local output="$TMP_DIR/dedicated-entrypoint.out"
  local status=0

  # The named entrypoint is the durable workload declaration. At 0% CPU idle
  # it must retain telemetry-only semantics without weakening any other gate.
  {
    printf 'cpu-0\n'
    printf 'healthy\n'
    printf 'healthy\n'
  } >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_DEDICATED_WRAPPER" \
      --label "dedicated-entrypoint" \
      -- bash -c 'touch "$1"; [[ "$2" = "--cpu-policy" ]]' _ "$marker" --cpu-policy \
      >"$output" 2>&1
  [[ -f "$marker" && ! -e "$lock_path" ]] ||
    fail "dedicated entrypoint restored standard CPU gates or leaked its lease"
  grep -Fq \
    'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=dedicated-agent phase=preflight status=observed enforcement=telemetry_only metric=cpu_idle_percent observed=0 threshold=none unit=percent' \
    "$output" || fail "dedicated entrypoint lost 0% idle telemetry-only semantics"
  grep -Fq 'HEAVY_LOCAL_SLOT_RECEIPT status=granted policy=standard cpu_policy=dedicated-agent' \
    "$output" || fail "dedicated entrypoint omitted its explicit CPU policy receipt"
  /bin/rm -f "$marker"

  # Callers cannot accidentally paste a standard override into this path. The
  # mismatch fails before admission with a stable, actionable policy receipt.
  set +e
  "$FIXTURE_DEDICATED_WRAPPER" \
    --cpu-policy standard \
    --label "dedicated-entrypoint-conflict" \
    --check >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] ||
    fail "dedicated entrypoint policy conflict returned $status instead of 75"
  [[ ! -e "$lock_path" ]] || fail "dedicated entrypoint conflict acquired the lease"
  grep -Fq \
    'class=guard_internal code=wrong_cpu_policy declared=dedicated-agent observed=caller_override phase=admission outcome=refused next_action=remove_cpu_policy_override_and_use_dedicated_agent_entrypoint' \
    "$output" || fail "dedicated entrypoint conflict omitted its actionable receipt"
  grep -Fq \
    'the dedicated-agent entrypoint owns CPU policy and does not accept a caller override' \
    "$output" || fail "dedicated entrypoint conflict omitted its human root cause"

  # A literal `--` is valid option data (for example, a label) and must not be
  # confused with the guarded-command delimiter. Keep scanning after the value
  # so the same conflicting override still fails before host admission.
  set +e
  "$FIXTURE_DEDICATED_WRAPPER" \
    --label -- \
    --cpu-policy standard \
    --check >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] ||
    fail "dedicated entrypoint literal-delimiter value bypass returned $status instead of 75"
  grep -Fq 'code=wrong_cpu_policy' "$output" ||
    fail "dedicated entrypoint mistook a literal option value for the command delimiter"

  pass "dedicated entrypoint cannot silently fall back to standard CPU gates"
}

test_dedicated_entrypoint_injects_only_the_safe_default_wait() {
  local capture_root="$TMP_DIR/dedicated-wait-capture"
  local capture_wrapper="$capture_root/scripts/with-dedicated-agent-slot.sh"
  local captured_arguments="$capture_root/arguments"

  mkdir -p "$capture_root/scripts"
  cp "$ROOT_DIR/scripts/with-dedicated-agent-slot.sh" "$capture_wrapper"

  # Replace only the lower wrapper in this disposable root. Capturing one
  # argument per line proves the dedicated entrypoint's parsing and forwarding
  # without invoking admission or depending on current host capacity.
  cat >"$capture_root/scripts/with-heavy-local-slot.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$DEDICATED_WAIT_CAPTURE_PATH"
EOF
  chmod +x "$capture_root/scripts/with-heavy-local-slot.sh"

  DEDICATED_WAIT_CAPTURE_PATH="$captured_arguments" \
    "$capture_wrapper" --label ordinary -- printf '%s\n' --check
  diff -u - "$captured_arguments" <<'EOF' ||
--cpu-policy
dedicated-agent
--wait-seconds
86400
--label
ordinary
--
printf
%s\n
--check
EOF
    fail "ordinary dedicated work did not receive the 86400-second default wait"

  DEDICATED_WAIT_CAPTURE_PATH="$captured_arguments" \
    "$capture_wrapper" --label override --wait-seconds 17 -- true
  diff -u - "$captured_arguments" <<'EOF' ||
--cpu-policy
dedicated-agent
--label
override
--wait-seconds
17
--
true
EOF
    fail "explicit dedicated wait was duplicated or replaced"

  DEDICATED_WAIT_CAPTURE_PATH="$captured_arguments" \
    "$capture_wrapper" --label snapshot --check
  diff -u - "$captured_arguments" <<'EOF' ||
--cpu-policy
dedicated-agent
--label
snapshot
--check
EOF
    fail "dedicated check-only call received a wait"

  # Strings that resemble control flags are data when consumed as option
  # values, and everything after the real delimiter belongs to the command.
  # Neither position may silently disable the ordinary default wait.
  DEDICATED_WAIT_CAPTURE_PATH="$captured_arguments" \
    "$capture_wrapper" --label --check --policy --wait-seconds -- true --check
  diff -u - "$captured_arguments" <<'EOF' ||
--cpu-policy
dedicated-agent
--wait-seconds
86400
--label
--check
--policy
--wait-seconds
--
true
--check
EOF
    fail "flag-like values or command arguments changed dedicated wait parsing"

  # A malformed explicit wait remains explicit and reaches the lower guard
  # unchanged. Injecting a valid default here would hide the caller error or
  # alter which usage failure the fail-closed parser reports.
  DEDICATED_WAIT_CAPTURE_PATH="$captured_arguments" \
    "$capture_wrapper" --wait-seconds --check
  diff -u - "$captured_arguments" <<'EOF' ||
--cpu-policy
dedicated-agent
--wait-seconds
--check
EOF
    fail "malformed explicit wait was hidden by a default"

  pass "dedicated entrypoint defaults ordinary work to the safe bounded wait only"
}

test_reachable_http_errors_keep_their_status() {
  local port_path="$TMP_DIR/jarvis-http-error.port"
  local server_output="$TMP_DIR/jarvis-http-error-server.out"
  local server_pid="" port="" path="" expected_status=""
  local http_sample="" http_status="" latency_seconds=""

  # Exercise the exact curl contract used by production against a real local
  # HTTP server. A fixture-only classifier test cannot catch curl --fail
  # discarding 4xx/5xx responses before their status reaches that classifier.
  node -e '
    const fs = require("fs");
    const http = require("http");
    const portPath = process.argv[1];
    const server = http.createServer((request, response) => {
      const status = request.url === "/client-error" ? 404 : 503;
      response.writeHead(status, { "content-type": "text/plain" });
      response.end("fixture\n");
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(portPath, String(server.address().port));
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => server.close(() => process.exit(0)));
    }
  ' "$port_path" >"$server_output" 2>&1 &
  server_pid=$!
  wait_for_file "$port_path"
  port="$(<"$port_path")"
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || fail "HTTP error fixture published an invalid port"

  for path in client-error server-error; do
    if [ "$path" = "client-error" ]; then
      expected_status=404
    else
      expected_status=503
    fi
    if ! http_sample="$(
      curl -sS -o /dev/null \
        --max-time 3 \
        -w '%{http_code}|%{time_total}' \
        "http://127.0.0.1:${port}/${path}" 2>/dev/null
    )"; then
      fail "reachable HTTP ${expected_status} was reduced to a request failure"
    fi
    IFS='|' read -r http_status latency_seconds <<<"$http_sample"
    [[ "$http_status" == "$expected_status" ]] ||
      fail "reachable HTTP ${expected_status} was reported as ${http_status:-missing}"
    [[ "$latency_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
      fail "reachable HTTP ${expected_status} lost latency telemetry"
  done

  kill -TERM "$server_pid"
  wait "$server_pid"
  pass "reachable HTTP 4xx/5xx responses preserve their decisive status"
}

test_dedicated_resource_guardrails_are_fail_safe_and_observable() {
  local lock_path="$TMP_DIR/dedicated-resource.lock"
  local health_path="$TMP_DIR/dedicated-resource.health"
  local marker="$TMP_DIR/dedicated-resource.marker"
  local output="$TMP_DIR/dedicated-resource.out"
  local fanout_fixture=""
  local fanout_child_pid_file="$TMP_DIR/dedicated-resource-fanout.child"
  local fanout_grandchild_pid_file="$TMP_DIR/dedicated-resource-fanout.grandchild"
  local fanout_child_pid=0 fanout_grandchild_pid=0
  local secret_argument="must-not-appear-in-resource-telemetry"
  local sample="" expected_class="" expected_code="" expected_action=""
  local status=0

  # Exercise the production classifier directly. Fixture health samples below
  # validate orchestration and cleanup; this table validates the exact decision
  # used by the production sampler.
  # shellcheck source=scripts/lib/heavy-local-slot.sh
  source "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"
  openclaw_heavy_local_slot_active_paging 145 10032 ||
    fail "production classifier missed simultaneous pageout and swapout growth"
  if openclaw_heavy_local_slot_active_paging 145 0; then
    fail "production classifier treated pageouts alone as active swap pressure"
  fi
  if openclaw_heavy_local_slot_active_paging 0 10032; then
    fail "production classifier treated swapouts alone as active paging"
  fi
  set +e
  openclaw_heavy_local_slot_active_paging invalid 1
  status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "production classifier accepted invalid counters"

  # pmset writes error text containing both monitored keywords. The production
  # sampler must preserve its exit status so an unavailable thermal backend is
  # an internal measurement failure, never a false host-pressure reading.
  grep -Fq 'if thermal_output="$(/usr/bin/pmset -g therm 2>/dev/null)"; then' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "thermal sampler discards the native command exit status"
  grep -Fq 'if [ "$thermal_status" -ne 0 ]; then' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "thermal sampler does not fail closed on native command failure"
  if grep -Eq 'MIN_RUNTIME_SWAP_FREE|MAX_RUNTIME_SWAPOUT_GROWTH' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh"; then
    fail "yellow-pressure policy retained an unsupported absolute swap threshold"
  fi
  grep -Fq 'runtime_previous_pageouts_total' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "yellow-pressure policy does not track pageout intervals"
  grep -Fq 'confirmation_pressure_level' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "yellow admission does not recheck kernel pressure after confirmation"
  grep -Fq 'confirmation_memory_free' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "yellow admission does not recheck the 25% floor after confirmation"
  grep -Fq 'runtime_baseline_swapouts_total' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "runtime warn policy is not transaction-relative"
  grep -Fq 'managed Jarvis health endpoint returned HTTP %s' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "reachable non-200 Jarvis health response is not a concrete health failure"
  grep -Fq 'curl -sS -o /dev/null \' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh" ||
    fail "dedicated Jarvis probe does not preserve reachable HTTP error status"
  if grep -Fq 'curl -fsS -o /dev/null \' \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh"; then
    fail "dedicated Jarvis probe still discards reachable HTTP error status"
  fi

  # Every platform or identity hazard refuses before the command starts. An
  # unavailable required backend is guard_internal rather than a retryable host
  # reading, so a broken sampler cannot silently weaken the dedicated profile.
  for sample in \
    memory-active-paging \
    memory-critical \
    thermal-warning \
    jarvis-identity-mismatch \
    jarvis-identity-changed \
    jarvis-latency-timeout \
    jarvis-http-404 \
    jarvis-http-503 \
    disk-unavailable \
    resource-unavailable; do
    case "$sample" in
      memory-critical)
        expected_class=host_unhealthy
        expected_code=memory_pressure_state
        expected_action=wait_for_memory_pressure_normal
        ;;
      memory-active-paging)
        expected_class=host_unhealthy
        expected_code=active_paging_growth
        expected_action=wait_for_paging_pressure_recovery
        ;;
      thermal-warning)
        expected_class=host_unhealthy
        expected_code=thermal_pressure
        expected_action=wait_for_thermal_and_performance_pressure_clear
        ;;
      jarvis-identity-mismatch)
        expected_class=host_unhealthy
        expected_code=jarvis_listener_mismatch
        expected_action=restore_single_stable_jarvis_listener
        ;;
      jarvis-identity-changed)
        expected_class=host_unhealthy
        expected_code=jarvis_identity_changed
        expected_action=restore_single_stable_jarvis_listener
        ;;
      jarvis-latency-timeout)
        expected_class=host_unhealthy
        expected_code=jarvis_http_failed
        expected_action=restore_jarvis_healthz_http_200
        ;;
      jarvis-http-404 | jarvis-http-503)
        expected_class=host_unhealthy
        expected_code=jarvis_http_failed
        expected_action=restore_jarvis_healthz_http_200
        ;;
      disk-unavailable)
        expected_class=guard_internal
        expected_code=disk_measurement_failed
        expected_action=restore_disk_headroom_telemetry
        ;;
      resource-unavailable)
        expected_class=guard_internal
        expected_code=paging_measurement_failed
        expected_action=restore_native_memory_telemetry
        ;;
    esac
    printf '%s\n' "$sample" >"$health_path"
    set +e
    OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
    OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
      "$FIXTURE_WRAPPER" \
        --cpu-policy dedicated-agent \
        --label "resource-${sample}" \
        -- touch "$marker" >"$output" 2>&1
    status=$?
    set -e
    [[ "$status" -eq 75 ]] ||
      fail "$sample returned $status instead of fail-closed exit 75"
    [[ ! -e "$marker" && ! -e "$lock_path" ]] ||
      fail "$sample ran work or leaked the machine lease"
    grep -Fq "class=${expected_class} code=${expected_code}" "$output" ||
      fail "$sample omitted its stable refusal class/code"
    grep -Fq "phase=admission outcome=refused next_action=${expected_action}" "$output" ||
      fail "$sample omitted admission outcome or next safe action"
    grep -Fq "Next safe action: ${expected_action}." "$output" ||
      fail "$sample omitted its actionable human explanation"
    if [[ "$sample" =~ ^jarvis-http-(404|503)$ ]]; then
      grep -Fq "metric=jarvis_http_status observed=${BASH_REMATCH[1]} expected=200" "$output" ||
        fail "reachable non-200 Jarvis response omitted its decisive HTTP status"
      grep -Fq "managed Jarvis health endpoint returned HTTP ${BASH_REMATCH[1]}" "$output" ||
        fail "reachable non-200 Jarvis response omitted its human root cause"
    fi
  done

  # Yellow pressure with flat paging counters admits honestly. Kernel yellow is
  # provisional; it is not by itself proof of active memory exhaustion.
  {
    printf 'memory-warning-stable\n'
    printf 'healthy\n'
  } >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "resource-yellow-stable" \
      -- /usr/bin/true >"$output" 2>&1
  grep -Fq 'memory_pressure=warn' "$output" ||
    fail "stable yellow admission omitted its pressure telemetry"
  [[ ! -e "$lock_path" ]] || fail "stable yellow admission leaked the lease"

  # Paging totals and fanout/RSS are observations, not arbitrary kill limits.
  # A healthy advisory sample must admit the command and redact its argument.
  {
    printf 'resource-advisory\n'
    printf 'fanout-observed\n'
    printf 'healthy\n'
    printf 'healthy\n'
  } >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "resource-advisory" \
      -- bash -c 'sleep 0.2; touch "$1"' "$secret_argument" "$marker" \
      >"$output" 2>&1
  [[ -f "$marker" && ! -e "$lock_path" ]] ||
    fail "healthy resource telemetry blocked work or leaked the lease"
  grep -Fq 'HEAVY_LOCAL_RESOURCE_TELEMETRY cpu_policy=dedicated-agent' "$output" ||
    fail "paging trend telemetry was not emitted"
  grep -Fq \
    'paging_status=observed paging_enforcement=warn_active_paging_two_strike thermal_state=normal next_action=observe_pageout_swapout_trend' \
    "$output" || fail "paging observations look like an enforced universal threshold"
  grep -Fq 'HEAVY_LOCAL_GROUP_TELEMETRY cpu_policy=dedicated-agent' "$output" ||
    fail "fanout/RSS telemetry was not emitted"
  grep -Fq \
    'fanout_status=observed rss_status=observed next_action=inspect_guarded_group_growth_if_sustained' \
    "$output" || fail "fanout/RSS observations omitted their advisory action"
  if grep -Fq "$secret_argument" "$output"; then
    fail "resource telemetry exposed a guarded command argument"
  fi
  /bin/rm -f "$marker"

  # Repeated yellow samples remain admissible while both paging counters stay
  # flat. No absolute swap allocation or arbitrary page threshold is enforced.
  {
    printf 'healthy\n'
    printf 'memory-warning-stable\n'
    printf 'memory-warning-stable\n'
    printf 'healthy\n'
  } >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "memory-warning-stable" \
      -- bash -c 'sleep 0.2; touch "$1"' _ "$marker" >"$output" 2>&1
  [[ -f "$marker" && ! -e "$lock_path" ]] ||
    fail "stable runtime yellow pressure killed admitted work or leaked the lease"
  /bin/rm -f "$marker"

  {
    printf 'healthy\n'
    printf 'memory-active-paging\n'
    printf 'memory-active-paging\n'
  } >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "memory-active-paging" \
      -- bash -c 'sleep 1; touch "$1"' _ "$marker" >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 && ! -e "$marker" && ! -e "$lock_path" ]] ||
    fail "repeated active paging did not stop and clean the guarded tree"
  grep -Fq 'code=active_paging_growth' "$output" ||
    fail "runtime active-paging stop lost its structured reason"
  grep -Fq 'next_action=wait_for_paging_pressure_recovery' "$output" ||
    fail "runtime swapout stop omitted its recovery condition"

  # A single paging burst followed by a healthy sample is not a permanent
  # transaction failure. This mirrors long package/signing work: cumulative
  # growth remains observable, while only fresh interval growth can add a new
  # strike after recovery.
  {
    printf 'healthy\n'
    printf 'memory-active-paging\n'
    printf 'healthy\n'
    printf 'memory-warning-stable\n'
    printf 'memory-warning-stable\n'
    printf 'healthy\n'
  } >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "memory-swapout-recovered" \
      -- bash -c 'sleep 0.5; touch "$1"' _ "$marker" >"$output" 2>&1
  [[ -f "$marker" && ! -e "$lock_path" ]] ||
    fail "recovered runtime swapout burst poisoned later bounded warnings"
  /bin/rm -f "$marker"

  # One transient thermal sample is advisory to admitted work. A healthy next
  # sample resets the strike; two consecutive warnings stop the full tree.
  {
    printf 'healthy\n'
    printf 'thermal-warning\n'
    printf 'healthy\n'
    printf 'healthy\n'
  } >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "resource-transient" \
      -- bash -c 'sleep 0.2; touch "$1"' _ "$marker" >"$output" 2>&1
  [[ -f "$marker" && ! -e "$lock_path" ]] ||
    fail "one transient thermal warning killed admitted work"
  /bin/rm -f "$marker"

  {
    printf 'healthy\n'
    printf 'thermal-warning\n'
    printf 'thermal-warning\n'
  } >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "resource-two-strike" \
      -- bash -c 'sleep 1; touch "$1"' _ "$marker" >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] ||
    fail "repeated thermal pressure returned $status instead of 75"
  [[ ! -e "$marker" && ! -e "$lock_path" ]] ||
    fail "repeated thermal pressure failed tree cleanup or leaked the lease"
  grep -Fq 'code=thermal_pressure' "$output" ||
    fail "repeated thermal stop lost its structured reason"
  grep -Fq \
    'phase=runtime outcome=terminated next_action=wait_for_thermal_and_performance_pressure_clear' \
    "$output" || fail "repeated thermal stop omitted termination and wake condition"
  grep -Fq \
    'Guarded work terminated: macOS reports thermal or performance pressure. Next safe action: wait_for_thermal_and_performance_pressure_clear.' \
    "$output" || fail "repeated thermal stop omitted actionable human output"

  # Fanout measurement starts only after the committed process group exists.
  # Use the suite's blocking process-tree fixture instead of racing a one-second
  # completion marker against the monitor. The ready file proves both processes
  # exist before samples are consumed; their PIDs then prove exact tree cleanup.
  fanout_fixture="$(create_process_tree_fixture)"
  {
    printf 'fanout-unavailable\n'
    printf 'fanout-unavailable\n'
  } >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE="$fanout_grandchild_pid_file" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --cpu-policy dedicated-agent \
      --label "resource-fanout-unavailable" \
      -- "$fanout_fixture" "$fanout_child_pid_file" "$fanout_grandchild_pid_file" \
      >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] ||
    fail "unavailable fanout telemetry returned $status instead of 75"
  wait_for_file "$fanout_child_pid_file"
  wait_for_file "$fanout_grandchild_pid_file"
  fanout_child_pid="$(<"$fanout_child_pid_file")"
  fanout_grandchild_pid="$(<"$fanout_grandchild_pid_file")"
  wait_for_dead_pid "$fanout_child_pid"
  wait_for_dead_pid "$fanout_grandchild_pid"
  [[ ! -e "$lock_path" ]] ||
    fail "unavailable fanout telemetry leaked the machine lease"
  grep -Fq 'class=guard_internal code=fanout_measurement_failed' "$output" ||
    fail "fanout measurement failure lost its structured reason"
  grep -Fq \
    'phase=runtime outcome=terminated next_action=restore_guarded_process_group_telemetry' \
    "$output" || fail "fanout measurement failure omitted termination and repair action"
  pass "dedicated resource guardrails fail safe and preserve healthy work"
}

test_owner_publish_failure_is_actionable() {
  local lock_path="$TMP_DIR/owner-publish.lock"
  local health_path="$TMP_DIR/owner-publish.health"
  local output="$TMP_DIR/owner-publish.out"
  local status=0

  write_healthy_samples "$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_BLOCK_OWNER_WRITE=1 \
    "$FIXTURE_WRAPPER" --label "owner-publish-proof" --check >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 75 ]] || fail "owner publication failure returned $status instead of 75"
  grep -Fq \
    "HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=owner_publish_failed stage=fixture_before_owner_write owner_path=${lock_path}/owner" \
    "$output" ||
    fail "owner publication refusal omitted exact stage/path metadata"
  grep -Fq \
    "Refusing heavy work: could not publish lease owner metadata" \
    "$output" ||
    fail "owner publication refusal lost its human remediation message"
  [[ ! -e "$lock_path" ]] || fail "failed owner publication leaked its fixture lease"
  pass "owner publication failure reports exact stage and metadata path"
}

test_large_generated_state_emits_owner_receipt() {
  local lock_path="$TMP_DIR/task-disk-receipt.lock"
  local health_path="$TMP_DIR/task-disk-receipt.health"
  local repo_path="$TMP_DIR/task disk receipt repo"
  local telemetry_repo_path=""
  local output="$TMP_DIR/task-disk-receipt.out"

  mkdir -p "$repo_path"
  repo_path="$(cd "$repo_path" && pwd -P)"
  telemetry_repo_path="$(printf '%s' "$repo_path" | /usr/bin/sed 's/ /%20/g')"
  git -C "$repo_path" init -q
  write_healthy_samples "$health_path"
  (
    cd "$repo_path"
    OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
    OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
      "$FIXTURE_WRAPPER" \
        --label "task-disk-receipt" \
        -- \
        bash -c 'mkdir -p dist && dd if=/dev/zero of=dist/generated.bin bs=1024 count=4 status=none'
  ) >"$output" 2>&1

  if ! grep -Fq \
    "HEAVY_LOCAL_DISK_RECEIPT status=owner_cleanup_required worktree=${telemetry_repo_path}" \
    "$output"; then
    cat "$output" >&2
    fail "large generated task state omitted its owner receipt"
  fi
  grep -Eq 'created_kib=[1-9][0-9]*' "$output" ||
    fail "task disk receipt omitted a positive created-state measurement"
  grep -Fq 'threshold_kib=1' "$output" ||
    fail "task disk receipt omitted its threshold"
  [[ ! -e "$lock_path" ]] || fail "task disk receipt test leaked its fixture lease"
  pass "large generated task state emits an exact owner receipt"
}

test_disk_pressure_refuses_and_warning_admits() {
  local lock_path="$TMP_DIR/disk-health.lock"
  local health_path="$TMP_DIR/disk-health.health"
  local output="$TMP_DIR/disk-health.out"
  local status=0

  printf 'disk-low\n' >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" --label "disk-low" --check >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "disk floor refusal returned $status instead of 75"
  grep -Fq \
    'HEAVY_LOCAL_SLOT_REFUSAL class=host_unhealthy code=disk_pressure metric=disk_available_kib observed=25000000 threshold=26214400 unit=KiB' \
    "$output" ||
    fail "disk floor refusal omitted stable measurements"
  [[ ! -e "$lock_path" ]] || fail "disk floor refusal leaked its fixture lease"

  printf 'disk-warning\n' >"$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" --label "disk-warning" --check >"$output" 2>&1
  grep -Fq \
    'HEAVY_LOCAL_DISK_REPORT status=warning observed_kib=34000000 report_below_kib=36700160 hard_floor_kib=26214400 owner=disk-warning' \
    "$output" ||
    fail "disk warning omitted its exact report thresholds"
  grep -Fq 'Heavy-local slot granted to "disk-warning".' "$output" ||
    fail "disk warning incorrectly blocked admission above the hard floor"
  [[ ! -e "$lock_path" ]] || fail "disk warning check leaked its fixture lease"
  pass "disk floor refuses with telemetry while the warning band admits honestly"
}

test_wrapper_waits_for_explicit_handshake_commit() {
  local lock_path="$TMP_DIR/handshake-commit.lock"
  local health_path="$TMP_DIR/handshake-commit.health"
  local ready_path="$TMP_DIR/handshake-commit.ready"
  local release_path="$TMP_DIR/handshake-commit.release"
  local body_marker="$TMP_DIR/handshake-commit.body"
  local output="$TMP_DIR/handshake-commit.out"
  local wrapper_pid=0 status=0

  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_READY_FILE="$ready_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_RELEASE_FILE="$release_path" \
    "$FIXTURE_WRAPPER" \
      --label "handshake-commit" \
      -- \
      bash -c ': >"$1"' _ "$body_marker" \
      >"$output" 2>&1 &
  wrapper_pid=$!
  wait_for_file "$ready_path"

  # The runner has installed complete metadata but deliberately has not
  # committed it. Give the wrapper several polling intervals to prove this
  # transitional state is waited through rather than rejected.
  [[ -f "$lock_path/child_pid" ]] || fail "handshake fixture did not publish metadata"
  [[ -f "$lock_path/child_pending" ]] || fail "handshake fixture lost its pending marker"
  [[ ! -e "$lock_path/child_committed" ]] || fail "handshake fixture committed before release"
  sleep 0.2
  kill -0 "$wrapper_pid" 2>/dev/null || fail "wrapper rejected transitional handshake metadata"
  [[ ! -e "$body_marker" ]] || fail "guarded body ran before handshake commit"
  if grep -Fq 'metadata was not published safely' "$output"; then
    fail "wrapper reported the transitional handshake as unsafe"
  fi

  : >"$release_path"
  set +e
  wait "$wrapper_pid"
  status=$?
  set -e
  [[ "$status" -eq 0 ]] || fail "committed handshake returned $status instead of 0"
  [[ -f "$body_marker" ]] || fail "guarded body did not run after handshake commit"
  [[ ! -e "$lock_path" ]] || fail "committed handshake leaked its fixture lease"
  pass "wrapper waits for explicit metadata commit across publication race"
}

test_pending_signal_never_executes_guarded_body() {
  local lock_path="$TMP_DIR/pending-signal.lock"
  local health_path="$TMP_DIR/pending-signal.health"
  local ready_path="$TMP_DIR/pending-signal.ready"
  local release_path="$TMP_DIR/pending-signal.release"
  local body_marker="$TMP_DIR/pending-signal.body"
  local output="$TMP_DIR/pending-signal.out"
  local owner_pid="" runner_pid="" wrapper_pid=0 status=0

  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_READY_FILE="$ready_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HANDSHAKE_RELEASE_FILE="$release_path" \
    "$FIXTURE_WRAPPER" \
      --label "pending-signal" \
      -- \
      bash -c ': >"$1"' _ "$body_marker" \
      >"$output" 2>&1 &
  wrapper_pid=$!
  wait_for_file "$ready_path"

  owner_pid="$(/usr/bin/sed -n 's/^pid=//p' "$lock_path/owner")"
  runner_pid="$(/usr/bin/sed -n 's/^pid=//p' "$lock_path/child_pid")"
  [[ "$owner_pid" == "$wrapper_pid" ]] ||
    fail "pending signal fixture shell job is not the recorded owner"
  [[ "$runner_pid" =~ ^[1-9][0-9]*$ ]] ||
    fail "pending signal fixture did not publish a runner PID"
  [[ -f "$lock_path/child_pending" && ! -e "$lock_path/child_committed" ]] ||
    fail "pending signal fixture escaped the intended pre-commit window"

  kill -TERM "$owner_pid"
  set +e
  wait "$wrapper_pid"
  status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "pending signal wrapper returned $status instead of 143"

  # Release only the disposable pause after the owner is reaped. The production
  # owner check must then reject commit/exec and let the runner exit by itself.
  : >"$release_path"
  wait_for_dead_pid "$runner_pid"
  [[ ! -e "$body_marker" ]] || fail "pending signal allowed the guarded body to run"
  [[ ! -e "$lock_path/child_committed" ]] ||
    fail "pending signal runner committed after losing its exact owner"
  [[ ! -e "$lock_path/child_authorized" ]] ||
    fail "pending signal published execution authorization"
  grep -Fq 'lease retained because guarded process cleanup was not proven safe' "$output" ||
    fail "pending signal did not retain the fail-closed lease"
  pass "pending-window signal cannot leave an unsupervised guarded body"
}

test_authoritative_session_identity_ignores_macos_ps_zero() {
  local lock_path="$TMP_DIR/session-identity.lock"
  local health_path="$TMP_DIR/session-identity.health"
  local ready_path="$TMP_DIR/session-identity.ready"
  local release_path="$TMP_DIR/session-identity.release"
  local leader_pid="" legacy_ps_session="" holder_pid=0 status=0

  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --label "session-identity" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' \
        _ "$ready_path" "$release_path" &
  holder_pid=$!
  wait_for_file "$ready_path"
  wait_for_file "$lock_path/child_committed"

  source "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh"
  leader_pid="$(openclaw_heavy_local_slot_value "$lock_path/child_pid" pid)"
  [[ "$leader_pid" =~ ^[1-9][0-9]*$ ]] || fail "session fixture leader PID is invalid"

  # macOS exposes a kernel session pointer through this ps field, not getsid().
  # Preserve the observed zero as a regression fact while proving the syscall
  # identity query still authenticates the live dedicated session.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    legacy_ps_session="$(
      LC_ALL=C /bin/ps -p "$leader_pid" -o sess= 2>/dev/null |
        /usr/bin/awk '{$1=$1; print}'
    )"
    [[ "$legacy_ps_session" == "0" ]] ||
      fail "macOS ps sess regression expected 0, got ${legacy_ps_session:-empty}"
  fi
  openclaw_heavy_local_slot_child_group_status "$lock_path" ||
    fail "syscall-backed session identity rejected the live committed leader"

  export OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_SESSION_MISMATCH=1
  if openclaw_heavy_local_slot_child_group_status "$lock_path"; then
    status=0
  else
    status=$?
  fi
  unset OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_SESSION_MISMATCH
  [[ "$status" -eq 2 ]] ||
    fail "authoritative session mismatch returned $status instead of ambiguous"

  : >"$release_path"
  wait "$holder_pid"
  [[ ! -e "$lock_path" ]] || fail "session identity fixture leaked its lease"
  pass "syscall SID accepts actual match and rejects mismatch despite macOS ps sess=0"
}

test_persistent_committed_identity_ambiguity_fails_closed() {
  local lock_path="$TMP_DIR/persistent-session-mismatch.lock"
  local health_path="$TMP_DIR/persistent-session-mismatch.health"
  local err_path="$TMP_DIR/persistent-session-mismatch.err"
  local out_path="$TMP_DIR/persistent-session-mismatch.out"
  local child_pid="" status=0

  write_healthy_samples "$health_path"
  export OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_SESSION_MISMATCH=1
  set +e
  run_test_wrapper \
    "$lock_path" \
    "$health_path" \
    "persistent-session-mismatch" \
    /bin/sleep 30 \
    >"$out_path" 2>"$err_path"
  status=$?
  set -e
  unset OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_SESSION_MISMATCH

  if [[ "$status" -ne 75 ]]; then
    printf 'Persistent mismatch fixture returned status %s.\n' "$status" >&2
    printf 'Fixture stdout:\n' >&2
    /usr/bin/sed -n '1,120p' "$out_path" >&2
    printf 'Fixture stderr:\n' >&2
    /usr/bin/sed -n '1,160p' "$err_path" >&2
    fail "persistent committed identity mismatch returned $status instead of 75"
  fi
  grep -Fq 'guarded child session metadata was not published safely' "$err_path" ||
    fail "persistent committed identity mismatch omitted the refusal"
  grep -Fq 'lease retained because guarded process cleanup was not proven safe' "$err_path" ||
    fail "persistent committed identity mismatch did not retain the lease"
  [[ -f "$lock_path/owner" && -f "$lock_path/child_committed" ]] ||
    fail "persistent committed identity mismatch released fail-closed metadata"
  child_pid="$(/usr/bin/sed -n 's/^pid=//p' "$lock_path/child_pid")"
  [[ "$child_pid" =~ ^[1-9][0-9]*$ ]] ||
    fail "persistent committed identity mismatch published an invalid child PID"
  ! kill -0 "$child_pid" 2>/dev/null ||
    fail "persistent committed identity mismatch left its guarded child alive"
  pass "persistent committed identity ambiguity remains fail-closed"
}

test_hostile_health_environment_cannot_weaken_policy() {
  local lock_path="$TMP_DIR/hostile-health.lock"
  local health_path="$TMP_DIR/hostile-health.health"
  local marker="$TMP_DIR/hostile-health.marker"
  local output="$TMP_DIR/hostile-health.out"
  local status=0

  printf 'synthetic host pressure\n' >"$health_path"
  set +e
  OPENCLAW_FLEET_MIN_MEMORY_FREE_PERCENT=0 \
  OPENCLAW_FLEET_MIN_CPU_IDLE_PERCENT=-100 \
  OPENCLAW_FLEET_RUNTIME_MIN_CPU_IDLE_PERCENT=not-a-number \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=999999 \
    run_test_wrapper \
      "$lock_path" \
      "$health_path" \
      "hostile-health-env" \
      touch "$marker" \
      >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 75 ]] || fail "hostile health environment returned $status instead of 75"
  [[ ! -e "$marker" ]] || fail "hostile health environment reached guarded work"
  grep -Fq 'synthetic host pressure' "$output" ||
    fail "hostile health environment hid the fixed-policy refusal"
  [[ ! -e "$lock_path" ]] || fail "hostile health environment leaked its lease"
  pass "ambient health values cannot weaken fixed admission policy"
}

create_minimal_clone_pair() {
  local seed="$TMP_DIR/clone-seed"
  local clone_a="$TMP_DIR/clone-a"
  local clone_b="$TMP_DIR/clone-b"

  mkdir -p "$seed/scripts/lib"
  cp "$FIXTURE_WRAPPER" "$seed/scripts/with-heavy-local-slot.sh"
  cp \
    "$FIXTURE_ROOT/scripts/gateway-lifecycle-command.sh" \
    "$seed/scripts/gateway-lifecycle-command.sh"
  cp "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh" "$seed/scripts/lib/heavy-local-slot.sh"
  cp \
    "$FIXTURE_ROOT/scripts/lib/heavy-local-slot-runner.pl" \
    "$seed/scripts/lib/heavy-local-slot-runner.pl"
  cp \
    "$FIXTURE_ROOT/scripts/lib/heavy-local-slot-health-fixture.sh" \
    "$seed/scripts/lib/heavy-local-slot-health-fixture.sh"
  git -C "$seed" init -q
  git -C "$seed" add scripts
  git -C "$seed" \
    -c user.name="Heavy Slot Test" \
    -c user.email="heavy-slot-test@example.invalid" \
    commit -qm "test: seed heavy slot clones"
  git clone -q "$seed" "$clone_a"
  git clone -q "$seed" "$clone_b"
}

test_machine_wide_default_and_separate_clone_contention() {
  local clone_a="$TMP_DIR/clone-a"
  local clone_b="$TMP_DIR/clone-b"
  local lock_path="$TMP_DIR/cross-clone.lock"
  local holder_health="$TMP_DIR/cross-clone-holder.health"
  local contender_health="$TMP_DIR/cross-clone-contender.health"
  local ready="$TMP_DIR/cross-clone.ready"
  local release="$TMP_DIR/cross-clone.release"
  local holder_out="$TMP_DIR/cross-clone-holder.out"
  local holder_err="$TMP_DIR/cross-clone-holder.err"
  local contender_err="$TMP_DIR/cross-clone-contender.err"
  local loser_mutations="$TMP_DIR/cross-clone-loser-mutations.log"
  local path_a="" path_b=""
  local guarded_pid="" holder_pid=0 holder_status=0 ready_attempt=0 status=0

  create_minimal_clone_pair
  path_a="$(
    cd "$clone_a"
    TMPDIR="$TMP_DIR/clone-a-tmp" \
      bash -c 'source "$1/scripts/lib/heavy-local-slot.sh"; openclaw_heavy_local_slot_resolve_path' _ "$ROOT_DIR"
  )"
  path_b="$(
    cd "$clone_b"
    TMPDIR="$TMP_DIR/clone-b-tmp" \
      bash -c 'source "$1/scripts/lib/heavy-local-slot.sh"; openclaw_heavy_local_slot_resolve_path' _ "$ROOT_DIR"
  )"
  [[ "$path_a" == "$path_b" ]] || fail "separate clones derived different default lock paths"
  [[ "$path_a" == /tmp/openclaw-heavy-local-slots-*/machine-wide.lock ]] ||
    fail "default lock path is not the UID-stable machine path"
  [[ "$path_a" != *"/.git/"* ]] || fail "default lock path still depends on Git metadata"

  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$clone_a/scripts/with-heavy-local-slot.sh" \
      --label "clone-a-holder" \
      -- \
      "$PERL_BIN" "$TERM_ATTRIBUTION_HOLDER" "$ready" "$release" "$SUITE_OS_PID" \
      >"$holder_out" 2>"$holder_err" &
  holder_pid=$!

  # Poll the shell's running-job registry as well as readiness. kill -0 alone
  # can report an exited-but-unreaped child, hiding the holder's real status
  # until the generic readiness timeout.
  while [[ ! -f "$ready" && "$ready_attempt" -lt 200 ]]; do
    if ! jobs -pr | grep -Fxq "$holder_pid"; then
      set +e
      wait "$holder_pid"
      holder_status=$?
      set -e
      printf 'FAIL: clone-a-holder exited before readiness with status %s.\n' "$holder_status" >&2
      printf 'clone-a-holder stdout:\n' >&2
      /usr/bin/sed -n '1,80p' "$holder_out" >&2
      printf 'clone-a-holder stderr:\n' >&2
      /usr/bin/sed -n '1,80p' "$holder_err" >&2
      fail "clone-a-holder died before publishing readiness"
    fi
    sleep 0.05
    ready_attempt=$((ready_attempt + 1))
  done
  if [[ ! -f "$ready" ]]; then
    printf 'clone-a-holder stdout before readiness timeout:\n' >&2
    /usr/bin/sed -n '1,80p' "$holder_out" >&2
    printf 'clone-a-holder stderr before readiness timeout:\n' >&2
    /usr/bin/sed -n '1,80p' "$holder_err" >&2
    fail "timed out waiting for clone-a-holder readiness"
  fi

  guarded_pid="$(
    /usr/bin/sed -n 's/^pid=//p' "$lock_path/child_pid"
  )"
  [[ "$guarded_pid" =~ ^[1-9][0-9]*$ ]] ||
    fail "clone-a-holder published an invalid guarded PID"
  # Capture the actual OS identities before contention. The signal callback
  # then supplies a kernel sender PID that can be matched to suite, wrapper,
  # holder, or a process outside this fixture.
  printf 'FIXTURE: pre-contention process identities (suite=%s wrapper=%s holder=%s):\n' \
    "$SUITE_OS_PID" \
    "$holder_pid" \
    "$guarded_pid" >>"$holder_err"
  LC_ALL=C /bin/ps \
    -p "$SUITE_OS_PID,$holder_pid,$guarded_pid" \
    -o pid=,ppid=,pgid=,command= >>"$holder_err"

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$contender_health" \
    "$clone_b/scripts/with-heavy-local-slot.sh" \
      --policy gateway-lifecycle \
      --label "gateway-restart:clone-b-contender" \
      -- "$clone_b/scripts/gateway-lifecycle-command.sh" cli -- bash -c \
        'printf "signal\nbootstrap\nkickstart\n" >>"$1"' \
        openclaw-gateway-restart-contender \
        "$loser_mutations" \
      >/dev/null 2>"$contender_err"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "separate-clone contender returned $status instead of 75"
  [[ ! -e "$loser_mutations" ]] ||
    fail "losing gateway restart contender reached signal/bootstrap/kickstart mutations"
  grep -Fq 'clone-a-holder' "$contender_err" || fail "contention omitted live cross-clone owner"
  if ! kill -0 "$holder_pid" 2>/dev/null; then
    set +e
    wait "$holder_pid"
    holder_status=$?
    set -e
    printf 'FAIL: clone-a-holder exited during contention with status %s.\n' "$holder_status" >&2
    printf 'clone-a-holder stdout:\n' >&2
    /usr/bin/sed -n '1,80p' "$holder_out" >&2
    printf 'clone-a-holder stderr:\n' >&2
    /usr/bin/sed -n '1,80p' "$holder_err" >&2
    fail "cross-clone contention harmed the holder"
  fi

  : >"$release"
  set +e
  wait "$holder_pid"
  holder_status=$?
  set -e
  if [[ "$holder_status" -ne 0 ]]; then
    printf 'FAIL: clone-a-holder returned status %s after release.\n' "$holder_status" >&2
    printf 'clone-a-holder stdout:\n' >&2
    /usr/bin/sed -n '1,80p' "$holder_out" >&2
    printf 'clone-a-holder stderr:\n' >&2
    /usr/bin/sed -n '1,80p' "$holder_err" >&2
    fail "clone-a-holder did not exit cleanly"
  fi
  wait_for_absence "$lock_path"
  pass "machine-wide path and separate-clone gateway restart contention"
}

create_nested_fixture() {
  local fixture="$TMP_DIR/nested-fixture.sh"

  cat >"$fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

root="$1"
body_log="$2"
mode="$3"
depth="${4:-0}"
source "$root/scripts/lib/heavy-local-slot.sh"

openclaw_heavy_local_slot_require_or_reexec \
  "nested-fixture" \
  "$root" \
  "$0" \
  "$@"

printf 'body depth=%s token=%s\n' "$depth" "$OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN" >>"$body_log"
if [[ "$mode" == "nested" && "$depth" == "0" ]]; then
  "$0" "$root" "$body_log" "$mode" 1
fi
EOF
  chmod +x "$fixture"
  printf '%s\n' "$fixture"
}

test_nested_reuse_without_reacquire() {
  local fixture="" lock_path="$TMP_DIR/nested.lock"
  local health_path="$TMP_DIR/nested.health"
  local body_log="$TMP_DIR/nested.body"
  local output="$TMP_DIR/nested.out"
  local transient_identity_file="$TMP_DIR/nested.transient-identity"
  local grant_count=0 body_count=0 token_count=0

  fixture="$(create_nested_fixture)"
  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_TRANSIENT_IDENTITY_FILE="$transient_identity_file" \
    "$fixture" "$FIXTURE_ROOT" "$body_log" nested 0 >"$output"

  grant_count="$(grep -c 'Heavy-local slot granted' "$output" || true)"
  body_count="$(wc -l <"$body_log" | tr -d ' ')"
  token_count="$(awk -F'token=' '{print $2}' "$body_log" | sort -u | wc -l | tr -d ' ')"
  [[ "$grant_count" -eq 1 ]] || fail "nested entrypoint acquired $grant_count wrappers"
  [[ -f "$transient_identity_file" ]] ||
    fail "nested fixture did not exercise the transient committed-identity retry"
  [[ "$body_count" -eq 2 ]] || fail "nested fixture executed $body_count bodies"
  [[ "$token_count" -eq 1 ]] || fail "nested fixture did not inherit one lease token"
  [[ ! -e "$lock_path" ]] || fail "nested fixture left its lock behind"
  pass "nested canonical entrypoints reuse one verified lease"
}

test_forged_token_rejected() {
  local fixture="" lock_path="$TMP_DIR/forged.lock"
  local holder_health="$TMP_DIR/forged-holder.health"
  local contender_health="$TMP_DIR/forged-contender.health"
  local ready="$TMP_DIR/forged.ready"
  local release="$TMP_DIR/forged.release"
  local body_log="$TMP_DIR/forged.body"
  local err="$TMP_DIR/forged.err"
  local forged="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local holder_pid=0 status=0

  fixture="$(create_nested_fixture)"
  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "forged-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$contender_health" \
  OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN="$forged" \
    "$fixture" "$FIXTURE_ROOT" "$body_log" forged 0 >/dev/null 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "forged token returned $status instead of contention"
  [[ ! -e "$body_log" ]] || fail "forged token reached guarded fixture body"
  grep -Fq 'forged-holder' "$err" || fail "forged token did not fall back to real admission"

  : >"$release"
  wait "$holder_pid"
  pass "forged inheritance token is rejected"
}

test_copied_live_token_from_sibling_is_rejected() {
  local fixture="" lock_path="$TMP_DIR/copied-token.lock"
  local holder_health="$TMP_DIR/copied-token-holder.health"
  local contender_health="$TMP_DIR/copied-token-contender.health"
  local ready="$TMP_DIR/copied-token.ready"
  local release="$TMP_DIR/copied-token.release"
  local body_log="$TMP_DIR/copied-token.body"
  local err="$TMP_DIR/copied-token.err"
  local copied_token=""
  local holder_pid=0 status=0

  fixture="$(create_nested_fixture)"
  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "copied-token-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"
  copied_token="$(
    source "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh"
    openclaw_heavy_local_slot_value "$lock_path/owner" token
  )"
  [[ "$copied_token" =~ ^[0-9a-fA-F]{64}$ ]] || fail "could not read holder token for sibling regression"

  # This shell is a sibling of the guarded session, not a descendant of the
  # recorded wrapper. Even a byte-perfect live token must fall back to normal
  # admission and contend with the real holder.
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$contender_health" \
  OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN="$copied_token" \
    "$fixture" "$FIXTURE_ROOT" "$body_log" copied 0 >/dev/null 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "copied sibling token returned $status instead of contention"
  [[ ! -e "$body_log" ]] || fail "copied sibling token reached guarded fixture body"
  grep -Fq 'copied-token-holder' "$err" ||
    fail "copied sibling token did not resolve the real live owner"

  : >"$release"
  wait "$holder_pid"
  wait_for_absence "$lock_path"
  pass "copied live token from a same-user sibling cannot bypass admission"
}

test_stale_recovery_and_token_safe_cleanup() {
  local stale_lock="$TMP_DIR/stale.lock"
  local stale_health="$TMP_DIR/stale.health"
  local stale_marker="$TMP_DIR/stale.marker"
  local live_lock="$TMP_DIR/token-safe.lock"
  local live_health="$TMP_DIR/token-safe.health"
  local ready="$TMP_DIR/token-safe.ready"
  local release="$TMP_DIR/token-safe.release"
  local holder_pid=0

  mkdir "$stale_lock"
  {
    printf 'pid=99999999\n'
    printf 'token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    printf 'process_start=Mon Jan 1 00:00:00 2001\n'
    printf 'label=stale-owner\n'
  } >"$stale_lock/owner"
  write_healthy_samples "$stale_health"
  run_test_wrapper "$stale_lock" "$stale_health" "stale-reclaimer" touch "$stale_marker"
  [[ -f "$stale_marker" ]] || fail "stale lease was not reclaimed"
  [[ ! -e "$stale_lock" ]] || fail "reclaimed lease was not released"

  write_healthy_samples "$live_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$live_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$live_health" \
    "$FIXTURE_WRAPPER" \
      --label "token-safe-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$live_lock" \
    bash -c '
      source "$1/scripts/lib/heavy-local-slot.sh"
      OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=1
      OPENCLAW_HEAVY_LOCAL_SLOT_PATH="$2"
      OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      openclaw_heavy_local_slot_release
    ' _ "$FIXTURE_ROOT" "$live_lock"
  [[ -f "$live_lock/owner" ]] || fail "mismatched late cleanup removed a live owner"
  kill -0 "$holder_pid" 2>/dev/null || fail "token-safe cleanup harmed the holder"

  : >"$release"
  wait "$holder_pid"
  pass "stale recovery and token-matched cleanup"
}

test_ambiguous_owner_identity_fails_closed() {
  local health_path="$TMP_DIR/ambiguous-owner.health"
  local missing_owner_lock="$TMP_DIR/missing-owner.lock"
  local missing_start_lock="$TMP_DIR/missing-start.lock"
  local reused_pid_lock="$TMP_DIR/reused-pid.lock"
  local err_path="$TMP_DIR/ambiguous-owner.err"
  local status=0

  write_healthy_samples "$health_path"

  mkdir "$missing_owner_lock"
  set +e
  run_test_wrapper "$missing_owner_lock" "$health_path" "missing-owner" true \
    >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "missing owner metadata returned $status instead of 75"
  [[ -d "$missing_owner_lock" ]] || fail "missing owner metadata was reclaimed"
  grep -Fq 'no readable owner metadata' "$err_path" ||
    fail "missing owner metadata did not report fail-closed ownership"

  mkdir "$missing_start_lock"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n'
    printf 'label=missing-start-owner\n'
  } >"$missing_start_lock/owner"
  set +e
  run_test_wrapper "$missing_start_lock" "$health_path" "missing-start" true \
    >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "missing process start returned $status instead of 75"
  [[ -f "$missing_start_lock/owner" ]] || fail "missing process start was reclaimed"

  mkdir "$reused_pid_lock"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n'
    printf 'process_start=Mon Jan 1 00:00:00 2001\n'
    printf 'label=reused-pid-owner\n'
  } >"$reused_pid_lock/owner"
  set +e
  run_test_wrapper "$reused_pid_lock" "$health_path" "reused-pid" true \
    >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "PID-reuse ambiguity returned $status instead of 75"
  [[ -f "$reused_pid_lock/owner" ]] || fail "PID-reuse ambiguity was reclaimed"
  pass "missing metadata, missing start, and PID reuse fail closed"
}

test_child_status_propagation() {
  local lock_path="$TMP_DIR/status.lock"
  local health_path="$TMP_DIR/status.health"
  local status=0

  write_healthy_samples "$health_path"
  set +e
  run_test_wrapper "$lock_path" "$health_path" "status-probe" bash -c 'exit 42'
  status=$?
  set -e
  [[ "$status" -eq 42 ]] || fail "wrapper changed child status 42 to $status"
  [[ ! -e "$lock_path" ]] || fail "status propagation left its lock behind"
  pass "guarded child status propagates unchanged"
}

test_refusal_classes_and_internal_failure_distinction() {
  local occupied_lock="$TMP_DIR/classes-occupied.lock"
  local holder_health="$TMP_DIR/classes-holder.health"
  local contender_health="$TMP_DIR/classes-contender.health"
  local holder_ready="$TMP_DIR/classes-holder.ready"
  local holder_release="$TMP_DIR/classes-holder.release"
  local health_lock="$TMP_DIR/classes-health.lock"
  local health_file="$TMP_DIR/classes-health.health"
  local internal_lock="$TMP_DIR/classes-internal.lock"
  local internal_file="$TMP_DIR/classes-internal.health"
  local output="$TMP_DIR/classes.out"
  local marker="$TMP_DIR/classes.marker"
  local holder_pid=0 status=0

  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$occupied_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "classes-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' \
        _ "$holder_ready" "$holder_release" &
  holder_pid=$!
  wait_for_file "$holder_ready"

  set +e
  run_test_wrapper \
    "$occupied_lock" \
    "$contender_health" \
    "classes-occupied" \
    touch "$marker" \
    >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "occupied refusal returned $status instead of 75"
  grep -Fq 'HEAVY_LOCAL_SLOT_REFUSAL class=occupied code=live_owner' "$output" ||
    fail "occupied refusal omitted its structured class"
  [[ ! -e "$marker" ]] || fail "occupied refusal ran guarded work"

  printf 'synthetic host pressure\n' >"$health_file"
  set +e
  run_test_wrapper \
    "$health_lock" \
    "$health_file" \
    "classes-host-health" \
    touch "$marker" \
    >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "host-health refusal returned $status instead of 75"
  grep -Fq 'HEAVY_LOCAL_SLOT_REFUSAL class=host_unhealthy code=fixture_host_pressure' "$output" ||
    fail "host-health refusal omitted its structured class"
  [[ ! -e "$health_lock" ]] || fail "host-health refusal retained the lease"

  printf 'guard-internal\n' >"$internal_file"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$internal_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$internal_file" \
    "$FIXTURE_WRAPPER" \
      --label "classes-internal" \
      --wait-seconds 3 \
      -- \
      touch "$marker" \
      >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "guard-internal refusal returned $status instead of 75"
  grep -Fq \
    'HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=fixture_measurement_failed' \
    "$output" ||
    fail "guard-internal refusal omitted its structured class"
  ! grep -Fq 'Heavy-local slot queued' "$output" ||
    fail "guard-internal refusal was incorrectly retried"
  [[ ! -e "$internal_lock" ]] || fail "guard-internal refusal retained the lease"

  : >"$holder_release"
  wait "$holder_pid"
  pass "occupied, host-health, and guard-internal refusals are distinct"
}

test_wait_argument_bounds_fail_before_admission() {
  local lock_path="$TMP_DIR/wait-arguments.lock"
  local output="$TMP_DIR/wait-arguments.out"
  local invalid="" status=0

  for invalid in 08 00010 86401 999999999999999999999999; do
    set +e
    OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
      "$FIXTURE_WRAPPER" \
        --label "wait-arguments" \
        --wait-seconds "$invalid" \
        -- \
        true \
        >"$output" 2>&1
    status=$?
    set -e
    [[ "$status" -eq 2 ]] ||
      fail "invalid wait value $invalid returned $status instead of usage status 2"
    [[ ! -e "$lock_path" ]] || fail "invalid wait value $invalid reached admission"
  done
  pass "wait bounds reject leading-zero and overflowing values before admission"
}

test_queue_notice_sanitizes_untrusted_label() {
  local lock_path="$TMP_DIR/queue-label.lock"
  local holder_health="$TMP_DIR/queue-label-holder.health"
  local waiter_health="$TMP_DIR/queue-label-waiter.health"
  local holder_ready="$TMP_DIR/queue-label-holder.ready"
  local holder_release="$TMP_DIR/queue-label-holder.release"
  local output="$TMP_DIR/queue-label.out"
  local holder_pid=0 waiter_pid=0 status=0

  write_healthy_samples "$holder_health"
  write_healthy_samples "$waiter_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "queue-label-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' \
        _ "$holder_ready" "$holder_release" &
  holder_pid=$!
  wait_for_file "$holder_ready"

  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$waiter_health" \
    "$FIXTURE_WRAPPER" \
      --label $'unsafe\nlabel\033[31m' \
      --wait-seconds 30 \
      -- \
      true \
      >"$output" 2>&1 &
  waiter_pid=$!
  wait_for_text "$output" 'Heavy-local slot queued for "unsafelabel31m"'
  kill -TERM "$waiter_pid"
  set +e
  wait "$waiter_pid"
  status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "unsafe-label waiter returned $status instead of 143"
  assert_one_line "$output" 'Heavy-local slot queued for "unsafelabel31m"'
  [[ "$(LC_ALL=C tr -cd '\033' <"$output" | wc -c | tr -d ' ')" -eq 0 ]] ||
    fail "queue output retained terminal escape characters"

  : >"$holder_release"
  wait "$holder_pid"
  pass "queue notice sanitizes untrusted labels into one safe line"
}

test_occupied_wait_runs_once_with_one_queue_notice() {
  local lock_path="$TMP_DIR/occupied-wait.lock"
  local holder_health="$TMP_DIR/occupied-wait-holder.health"
  local waiter_health="$TMP_DIR/occupied-wait-waiter.health"
  local holder_ready="$TMP_DIR/occupied-wait-holder.ready"
  local holder_release="$TMP_DIR/occupied-wait-holder.release"
  local command_receipt="$TMP_DIR/occupied-wait-command.receipt"
  local output="$TMP_DIR/occupied-wait.out"
  local holder_pid=0 waiter_pid=0 status=0

  write_healthy_samples "$holder_health"
  write_healthy_samples "$waiter_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "occupied-wait-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' \
        _ "$holder_ready" "$holder_release" &
  holder_pid=$!
  wait_for_file "$holder_ready"

  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$waiter_health" \
    "$FIXTURE_WRAPPER" \
      --label "occupied-waiter" \
      --wait-seconds 5 \
      -- \
      bash -c 'printf "run\n" >>"$1"' _ "$command_receipt" \
      >"$output" 2>&1 &
  waiter_pid=$!
  wait_for_text "$output" 'Heavy-local slot queued for "occupied-waiter"'
  : >"$holder_release"
  wait "$holder_pid"
  set +e
  wait "$waiter_pid"
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || fail "occupied waiter returned $status instead of 0"
  [[ "$(wc -l <"$command_receipt" | tr -d ' ')" -eq 1 ]] ||
    fail "occupied waiter did not execute its guarded command exactly once"
  assert_one_line "$output" 'Heavy-local slot queued for "occupied-waiter"'
  assert_one_line "$output" 'Heavy-local slot granted to "occupied-waiter"'
  [[ ! -e "$lock_path" ]] || fail "occupied waiter leaked its lease"
  pass "occupied wait acquires atomically and runs exactly once with one queue notice"
}

test_host_health_wait_releases_lease_then_runs_once() {
  local lock_path="$TMP_DIR/health-wait.lock"
  local health_path="$TMP_DIR/health-wait.health"
  local command_receipt="$TMP_DIR/health-wait-command.receipt"
  local output="$TMP_DIR/health-wait.out"
  local waiter_pid=0 status=0 sample=0

  : >"$health_path"
  while [[ "$sample" -lt 20 ]]; do
    printf 'synthetic host pressure\n' >>"$health_path"
    sample=$((sample + 1))
  done
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --label "health-waiter" \
      --wait-seconds 5 \
      -- \
      bash -c 'printf "run\n" >>"$1"' _ "$command_receipt" \
      >"$output" 2>&1 &
  waiter_pid=$!

  wait_for_text "$output" 'Heavy-local slot queued for "health-waiter"'
  wait_for_absence "$lock_path"
  write_healthy_samples "$health_path"
  set +e
  wait "$waiter_pid"
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || fail "host-health waiter returned $status instead of 0"
  [[ "$(wc -l <"$command_receipt" | tr -d ' ')" -eq 1 ]] ||
    fail "host-health waiter did not execute its guarded command exactly once"
  assert_one_line "$output" 'Heavy-local slot queued for "health-waiter"'
  [[ ! -e "$lock_path" ]] || fail "host-health waiter leaked its lease"
  pass "host-health wait sleeps without the lease and runs exactly once after recovery"
}

test_deadline_blocks_late_admission() {
  local lock_path="$TMP_DIR/deadline.lock"
  local holder_health="$TMP_DIR/deadline-holder.health"
  local waiter_health="$TMP_DIR/deadline-waiter.health"
  local holder_ready="$TMP_DIR/deadline-holder.ready"
  local holder_release="$TMP_DIR/deadline-holder.release"
  local marker="$TMP_DIR/deadline.marker"
  local output="$TMP_DIR/deadline.out"
  local holder_pid=0 releaser_pid=0 status=0

  write_healthy_samples "$holder_health"
  write_healthy_samples "$waiter_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "deadline-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' \
        _ "$holder_ready" "$holder_release" &
  holder_pid=$!
  wait_for_file "$holder_ready"

  (
    trap - EXIT INT TERM HUP
    wait_for_text "$output" 'Heavy-local slot queued for "deadline-waiter"'
    : >"$holder_release"
  ) &
  releaser_pid=$!

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$waiter_health" \
    "$FIXTURE_WRAPPER" \
      --label "deadline-waiter" \
      --wait-seconds 1 \
      -- \
      touch "$marker" \
      >"$output" 2>&1
  status=$?
  set -e
  wait "$releaser_pid"
  wait "$holder_pid"

  [[ "$status" -eq 75 ]] || fail "deadline waiter returned $status instead of 75"
  grep -Fq 'HEAVY_LOCAL_SLOT_REFUSAL class=occupied code=wait_timeout' "$output" ||
    fail "deadline waiter omitted its timeout classification"
  [[ ! -e "$marker" ]] || fail "deadline waiter launched after its deadline"
  [[ ! -e "$lock_path" ]] || fail "deadline waiter leaked its lease"
  pass "a slot freed during the final sleep cannot admit work after the deadline"
}

test_wait_timeout_and_cancel_never_run_command() {
  local lock_path="$TMP_DIR/wait-stop.lock"
  local holder_health="$TMP_DIR/wait-stop-holder.health"
  local waiter_health="$TMP_DIR/wait-stop-waiter.health"
  local holder_ready="$TMP_DIR/wait-stop-holder.ready"
  local holder_release="$TMP_DIR/wait-stop-holder.release"
  local marker="$TMP_DIR/wait-stop.marker"
  local timeout_output="$TMP_DIR/wait-timeout.out"
  local cancel_output="$TMP_DIR/wait-cancel.out"
  local holder_pid=0 waiter_pid=0 status=0

  write_healthy_samples "$holder_health"
  write_healthy_samples "$waiter_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "wait-stop-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' \
        _ "$holder_ready" "$holder_release" &
  holder_pid=$!
  wait_for_file "$holder_ready"

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$waiter_health" \
    "$FIXTURE_WRAPPER" \
      --label "timeout-waiter" \
      --wait-seconds 1 \
      -- \
      touch "$marker" \
      >"$timeout_output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "wait timeout returned $status instead of 75"
  grep -Fq 'HEAVY_LOCAL_SLOT_REFUSAL class=occupied code=wait_timeout' "$timeout_output" ||
    fail "wait timeout omitted its structured terminal reason"
  assert_one_line "$timeout_output" 'Heavy-local slot queued for "timeout-waiter"'
  [[ ! -e "$marker" ]] || fail "timed-out waiter ran guarded work"

  write_healthy_samples "$waiter_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$waiter_health" \
    "$FIXTURE_WRAPPER" \
      --label "cancel-waiter" \
      --wait-seconds 30 \
      -- \
      touch "$marker" \
      >"$cancel_output" 2>&1 &
  waiter_pid=$!
  wait_for_text "$cancel_output" 'Heavy-local slot queued for "cancel-waiter"'
  kill -TERM "$waiter_pid"
  set +e
  wait "$waiter_pid"
  status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "cancelled waiter returned $status instead of 143"
  assert_one_line "$cancel_output" 'Heavy-local slot queued for "cancel-waiter"'
  [[ ! -e "$marker" ]] || fail "cancelled waiter ran guarded work"
  kill -0 "$holder_pid" 2>/dev/null || fail "cancelled waiter harmed the live holder"

  : >"$holder_release"
  wait "$holder_pid"
  [[ ! -e "$lock_path" ]] || fail "wait timeout/cancel leaked the holder lease"
  pass "bounded timeout and cancellation never execute or disturb the holder"
}

create_stubborn_orphan_fixture() {
  local fixture="$TMP_DIR/stubborn-orphan-fixture.sh"

  cat >"$fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

leader_pid_file="$1"
stubborn_pid_file="$2"
mode="$3"

printf '%s\n' "$$" >"$leader_pid_file"
bash -c '
  trap "" TERM HUP INT
  printf "%s\n" "$$" >"$1"
  while true; do sleep 1; done
' _ "$stubborn_pid_file" &
stubborn_pid=$!

if [[ "$mode" == "root-exits" ]]; then
  exit 0
fi
wait "$stubborn_pid"
EOF
  chmod +x "$fixture"
  printf '%s\n' "$fixture"
}

test_root_exit_kills_term_ignoring_orphan_group() {
  local fixture="" lock_path="$TMP_DIR/root-exit-orphan.lock"
  local health_path="$TMP_DIR/root-exit-orphan.health"
  local leader_pid_file="$TMP_DIR/root-exit-orphan.leader"
  local stubborn_pid_file="$TMP_DIR/root-exit-orphan.stubborn"
  local status=0 leader_pid=0 stubborn_pid=0

  fixture="$(create_stubborn_orphan_fixture)"
  write_healthy_samples "$health_path"
  set +e
  run_test_wrapper \
    "$lock_path" \
    "$health_path" \
    "root-exit-orphan" \
    "$fixture" "$leader_pid_file" "$stubborn_pid_file" root-exits
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || fail "root-exit orphan cleanup returned $status instead of 0"
  wait_for_file "$leader_pid_file"
  wait_for_file "$stubborn_pid_file"
  leader_pid="$(<"$leader_pid_file")"
  stubborn_pid="$(<"$stubborn_pid_file")"
  wait_for_dead_pid "$leader_pid"
  wait_for_dead_pid "$stubborn_pid"
  [[ ! -e "$lock_path" ]] || fail "root-exit orphan cleanup leaked its lease"
  pass "root exit kills a TERM-ignoring background orphan before release"
}

test_wrapper_sigkill_retains_lease_until_orphan_group_dies() {
  local fixture="" lock_path="$TMP_DIR/wrapper-sigkill.lock"
  local holder_health="$TMP_DIR/wrapper-sigkill-holder.health"
  local contender_health="$TMP_DIR/wrapper-sigkill-contender.health"
  local leader_pid_file="$TMP_DIR/wrapper-sigkill.leader"
  local stubborn_pid_file="$TMP_DIR/wrapper-sigkill.stubborn"
  local contender_marker="$TMP_DIR/wrapper-sigkill.contender"
  local reclaimed_marker="$TMP_DIR/wrapper-sigkill.reclaimed"
  local err="$TMP_DIR/wrapper-sigkill.err"
  local owner_pid=0 holder_pid=0 pgid=0 status=0

  fixture="$(create_stubborn_orphan_fixture)"
  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
    "$FIXTURE_WRAPPER" \
      --label "wrapper-sigkill-holder" \
      -- \
      "$fixture" "$leader_pid_file" "$stubborn_pid_file" wait &
  holder_pid=$!
  wait_for_file "$lock_path/owner"
  wait_for_file "$lock_path/child_pid"
  wait_for_file "$stubborn_pid_file"

  source "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh"
  owner_pid="$(openclaw_heavy_local_slot_value "$lock_path/owner" pid)"
  pgid="$(openclaw_heavy_local_slot_value "$lock_path/child_pid" pgid)"
  [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] || fail "SIGKILL fixture owner PID is invalid"
  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] || fail "SIGKILL fixture PGID is invalid"
  [[ "$owner_pid" -eq "$holder_pid" ]] || fail "SIGKILL fixture shell job is not the lease owner"

  kill -KILL "$owner_pid"
  set +e
  wait "$holder_pid"
  status=$?
  set -e
  [[ "$status" -eq 137 ]] || fail "SIGKILLed wrapper returned $status instead of 137"
  kill -0 -- "-$pgid" 2>/dev/null || fail "SIGKILL did not leave the guarded orphan group alive"

  set +e
  run_test_wrapper \
    "$lock_path" \
    "$contender_health" \
    "wrapper-sigkill-contender" \
    touch "$contender_marker" \
    >/dev/null 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "live orphan contender returned $status instead of 75"
  [[ ! -e "$contender_marker" ]] || fail "live orphan contender overlapped guarded work"
  grep -Fq 'live guarded process group' "$err" ||
    fail "live orphan contention did not identify the guarded process group"
  [[ -f "$lock_path/owner" ]] || fail "live orphan contention reclaimed the dead owner's lease"

  # The test owns this deliberately orphaned fixture group. Remove it explicitly,
  # prove the group is gone, then verify normal stale recovery can proceed.
  kill -KILL -- "-$pgid"
  wait_for_dead_group "$pgid"
  write_healthy_samples "$contender_health"
  run_test_wrapper \
    "$lock_path" \
    "$contender_health" \
    "wrapper-sigkill-reclaimer" \
    touch "$reclaimed_marker"
  [[ -f "$reclaimed_marker" ]] || fail "dead orphan group did not permit stale recovery"
  [[ ! -e "$lock_path" ]] || fail "post-orphan stale recovery leaked its lease"
  pass "wrapper SIGKILL cannot release or overlap a live guarded orphan group"
}

create_process_tree_fixture() {
  local fixture="$TMP_DIR/process-tree-fixture.sh"

  cat >"$fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

child_pid_file="$1"
grandchild_pid_file="$2"

bash -c '
  trap "exit 0" TERM HUP INT
  while true; do sleep 1; done
' &
grandchild_pid=$!
printf '%s\n' "$$" >"$child_pid_file"
printf '%s\n' "$grandchild_pid" >"$grandchild_pid_file"
wait "$grandchild_pid"
EOF
  chmod +x "$fixture"
  printf '%s\n' "$fixture"
}

test_two_sample_health_stop_kills_tree() {
  local fixture="" lock_path="$TMP_DIR/health-stop.lock"
  local health_path="$TMP_DIR/health-stop.health"
  local child_pid_file="$TMP_DIR/health-stop.child"
  local grandchild_pid_file="$TMP_DIR/health-stop.grandchild"
  local output="$TMP_DIR/health-stop.out"
  local status=0 child_pid=0 grandchild_pid=0

  fixture="$(create_process_tree_fixture)"
  {
    printf 'synthetic host pressure\n'
    printf 'synthetic host pressure\n'
  } >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE="$grandchild_pid_file" \
    run_test_wrapper \
      "$lock_path" \
      "$health_path" \
      "health-stop" \
      "$fixture" "$child_pid_file" "$grandchild_pid_file" \
      >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "health stop returned $status instead of 75"
  wait_for_file "$child_pid_file"
  wait_for_file "$grandchild_pid_file"
  child_pid="$(<"$child_pid_file")"
  grandchild_pid="$(<"$grandchild_pid_file")"
  wait_for_dead_pid "$child_pid"
  wait_for_dead_pid "$grandchild_pid"
  grep -Fq 'repeated host-health failures' "$output" || fail "health stop omitted reason"
  [[ ! -e "$lock_path" ]] || fail "health stop left its lock behind"
  pass "two unhealthy samples stop child and grandchild"
}

signal_verified_slot_owner() {
  local signal_name="$1"
  local expected_label="$2"
  local lock_path="$3"
  local child_pid_file="$4"
  local grandchild_pid_file="$5"
  local result_file="$6"
  local owner_path="$lock_path/owner"
  local attempt=0
  local owner_pid="" owner_token="" owner_start="" owner_label="" current_start=""
  local current_pid="" current_token="" recorded_start="" current_label=""

  # This helper is the only background shell in a signal case. It must never
  # inherit the suite's EXIT cleanup or respond to the signal it will target at
  # the separately verified foreground wrapper.
  trap - EXIT INT TERM HUP

  # First resolve a real owner. A bounded wait converts wrapper startup failures
  # into a finite result instead of leaving a signaler alive indefinitely.
  while [[ ! -f "$owner_path" && "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  if [[ ! -f "$owner_path" ]]; then
    printf 'owner metadata timeout before %s\n' "$signal_name" >"$result_file"
    return 1
  fi

  # Resolve and authenticate the exact lease owner rather than trusting the PID
  # of a shell job. This also proves the test exercises canonical owner metadata.
  source "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh"
  owner_pid="$(openclaw_heavy_local_slot_value "$owner_path" pid)"
  owner_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
  owner_start="$(openclaw_heavy_local_slot_value "$owner_path" process_start)"
  owner_label="$(openclaw_heavy_local_slot_value "$owner_path" label)"
  current_start="$(openclaw_heavy_local_slot_process_start "$owner_pid" || true)"
  if [[ ! "$owner_pid" =~ ^[1-9][0-9]*$ ||
    ! "$owner_token" =~ ^[0-9a-fA-F]{64}$ ||
    -z "$owner_start" ||
    "$owner_start" != "$current_start" ||
    "$owner_label" != "$expected_label" ]] ||
    ! kill -0 "$owner_pid" 2>/dev/null; then
    printf 'owner verification failed before %s\n' "$signal_name" >"$result_file"
    return 1
  fi

  # Once the target is authenticated, wait separately for the child tree. On a
  # fixture readiness failure, terminate only that verified owner so the
  # foreground test cannot hang while reporting the harness failure.
  attempt=0
  while [[ "$attempt" -lt 200 ]]; do
    if [[ -f "$child_pid_file" && -f "$grandchild_pid_file" ]]; then
      break
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  if [[ ! -f "$child_pid_file" || ! -f "$grandchild_pid_file" ]]; then
    kill -TERM "$owner_pid" 2>/dev/null || true
    printf 'tree readiness timeout before %s; terminated verified owner PID %s\n' \
      "$signal_name" \
      "$owner_pid" >"$result_file"
    return 1
  fi

  # Re-read every identity field after the readiness wait. A replacement owner
  # must never receive a signal intended for the process verified above.
  current_pid="$(openclaw_heavy_local_slot_value "$owner_path" pid)"
  current_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
  recorded_start="$(openclaw_heavy_local_slot_value "$owner_path" process_start)"
  current_label="$(openclaw_heavy_local_slot_value "$owner_path" label)"
  current_start="$(openclaw_heavy_local_slot_process_start "$current_pid" || true)"
  if [[ "$current_pid" != "$owner_pid" ||
    "$current_token" != "$owner_token" ||
    "$recorded_start" != "$owner_start" ||
    "$current_start" != "$owner_start" ||
    "$current_label" != "$expected_label" ]] ||
    ! kill -0 "$owner_pid" 2>/dev/null; then
    printf 'owner changed before %s\n' "$signal_name" >"$result_file"
    return 1
  fi

  if ! kill "-$signal_name" "$owner_pid" 2>/dev/null; then
    printf 'could not send %s to verified owner PID %s\n' "$signal_name" "$owner_pid" >"$result_file"
    return 1
  fi
  printf 'sent %s to verified owner PID %s\n' "$signal_name" "$owner_pid" >"$result_file"
}

run_signal_cleanup_case() {
  local signal_name="$1"
  local expected_status="$2"
  local fixture="$3"
  local selected_cpu_policy="${4:-standard}"
  local case_suffix="${signal_name}-${selected_cpu_policy}"
  local expected_label="signal-cleanup-${case_suffix}"
  local lock_path="$TMP_DIR/signal-${case_suffix}.lock"
  local health_path="$TMP_DIR/signal-${case_suffix}.health"
  local child_pid_file="$TMP_DIR/signal-${case_suffix}.child"
  local grandchild_pid_file="$TMP_DIR/signal-${case_suffix}.grandchild"
  local signaler_result="$TMP_DIR/signal-${case_suffix}.signaler"
  local output="$TMP_DIR/signal-${case_suffix}.out"
  local -a cpu_policy_args=()
  local signaler_pid=0 signaler_status=0 status=0 child_pid=0 grandchild_pid=0

  if [[ "$selected_cpu_policy" == "dedicated-agent" ]]; then
    cpu_policy_args=(--cpu-policy dedicated-agent)
  else
    # The production default is dedicated-agent. Signal fixtures that exercise
    # the shared policy must opt into its CPU floors explicitly.
    cpu_policy_args=(--cpu-policy standard)
  fi

  write_healthy_samples "$health_path"
  signal_verified_slot_owner \
    "$signal_name" \
    "$expected_label" \
    "$lock_path" \
    "$child_pid_file" \
    "$grandchild_pid_file" \
    "$signaler_result" &
  signaler_pid=$!

  # Keep the wrapper in the foreground relative to this suite. The Perl shim
  # first resets SIGINT inherited from any outer guarded/background launcher,
  # then execs the copied wrapper so its production INT trap is testable.
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$PERL_BIN" \
      "$SIGINT_RESET_LAUNCHER" \
      "$FIXTURE_WRAPPER" \
        "${cpu_policy_args[@]}" \
        --label "$expected_label" \
        -- \
        "$fixture" "$child_pid_file" "$grandchild_pid_file" \
      >"$output" 2>&1
  status=$?
  set -e

  set +e
  wait "$signaler_pid"
  signaler_status=$?
  set -e
  [[ "$signaler_status" -eq 0 ]] ||
    fail "$signal_name signaler failed: $(<"$signaler_result")"
  grep -Fq "sent $signal_name to verified owner PID" "$signaler_result" ||
    fail "$signal_name signaler did not record a verified send"

  child_pid="$(<"$child_pid_file")"
  grandchild_pid="$(<"$grandchild_pid_file")"
  [[ "$status" -eq "$expected_status" ]] ||
    fail "$signal_name returned $status instead of $expected_status"
  wait_for_dead_pid "$child_pid"
  wait_for_dead_pid "$grandchild_pid"
  wait_for_absence "$lock_path"
  pass "$signal_name stops the guarded tree with status $expected_status"
}

test_signal_cleanup_kills_tree_and_releases() {
  local fixture=""

  fixture="$(create_process_tree_fixture)"
  run_signal_cleanup_case TERM 143 "$fixture"
  run_signal_cleanup_case INT 130 "$fixture"
  run_signal_cleanup_case HUP 129 "$fixture"
  pass "TERM, INT, and HUP stop the guarded tree and release the lease"
}

test_dedicated_cpu_policy_preserves_signal_cleanup() {
  local fixture=""

  fixture="$(create_process_tree_fixture)"
  run_signal_cleanup_case TERM 143 "$fixture" dedicated-agent
  pass "dedicated CPU policy preserves signal propagation and exact cleanup"
}

test_jarvis_remediation_policy_is_narrow_and_non_ambient() {
  local standard_lock="$TMP_DIR/remediation-standard.lock"
  local ambient_lock="$TMP_DIR/remediation-ambient.lock"
  local wrong_command_lock="$TMP_DIR/remediation-wrong-command.lock"
  local allowed_lock="$TMP_DIR/remediation-allowed.lock"
  local health_path="$TMP_DIR/remediation.health"
  local marker="$TMP_DIR/remediation.marker"
  local output="$TMP_DIR/remediation.out"
  local sample=0 status=0

  printf 'jarvis-unhealthy\n' >"$health_path"
  set +e
  run_test_wrapper \
    "$standard_lock" \
    "$health_path" \
    "remediation-standard" \
    touch "$marker" \
    >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "standard policy ignored unhealthy Jarvis with status $status"
  [[ ! -e "$marker" ]] || fail "standard policy ran while Jarvis was unhealthy"

  printf 'jarvis-unhealthy\n' >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_POLICY=jarvis-remediation \
    run_test_wrapper \
      "$ambient_lock" \
      "$health_path" \
      "remediation-ambient" \
      touch "$marker" \
      >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "ambient remediation policy changed standard admission"
  [[ ! -e "$marker" ]] || fail "ambient remediation policy reached guarded work"

  write_healthy_samples "$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$wrong_command_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --policy jarvis-remediation \
      --label "remediation-wrong-command" \
      -- \
      /usr/bin/true \
      >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "noncanonical remediation command returned $status instead of 75"
  grep -Fq 'restricted to the canonical ship-jarvis-hotfix entrypoint' "$output" ||
    fail "noncanonical remediation command omitted the policy boundary"
  [[ ! -e "$wrong_command_lock" ]] || fail "wrong remediation command acquired a lease"

  : >"$health_path"
  while [[ "$sample" -lt 20 ]]; do
    printf 'jarvis-unhealthy\n' >>"$health_path"
    sample=$((sample + 1))
  done
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$allowed_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --policy jarvis-remediation \
      --label "remediation-canonical-hotfix" \
      -- \
      "$FIXTURE_ROOT/scripts/ship-jarvis-hotfix.sh" "$marker"
  [[ -f "$marker" ]] || fail "canonical remediation entrypoint did not run"
  [[ ! -e "$allowed_lock" ]] || fail "canonical remediation entrypoint leaked its lease"
  pass "Jarvis remediation is canonical-entrypoint-only and skips only Jarvis health"
}

test_gateway_lifecycle_policy_skips_only_gateway_health() {
  local lock_path="$TMP_DIR/gateway-lifecycle.lock"
  local health_path="$TMP_DIR/gateway-lifecycle.health"
  local marker="$TMP_DIR/gateway-lifecycle.marker"
  local stdout_path="$TMP_DIR/gateway-lifecycle.stdout"
  local sample=0

  : >"$health_path"
  while [[ "$sample" -lt 20 ]]; do
    printf 'jarvis-unhealthy\n' >>"$health_path"
    sample=$((sample + 1))
  done

  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --policy gateway-lifecycle \
      --label "gateway-restart:ai.jarvis.gateway" \
      -- \
      "$FIXTURE_ROOT/scripts/gateway-lifecycle-command.sh" cli -- touch "$marker" \
      >"$stdout_path"

  [[ -f "$marker" ]] || fail "gateway lifecycle policy deadlocked on the listener it must restart"
  [[ ! -s "$stdout_path" ]] ||
    fail "gateway lifecycle wrapper polluted structured command stdout"
  [[ ! -e "$lock_path" ]] || fail "gateway lifecycle policy leaked its lease"
  pass "gateway lifecycle policy preserves the lease while skipping gateway self-health"
}

test_gateway_lifecycle_inherits_verified_standard_owner() {
  local lock_path="$TMP_DIR/gateway-lifecycle-standard-owner.lock"
  local health_path="$TMP_DIR/gateway-lifecycle-standard-owner.health"
  local marker="$TMP_DIR/gateway-lifecycle-standard-owner.marker"

  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --label "restart-mac:unsigned-fixture" \
      -- \
      /bin/bash -c \
        'source "$1"; openclaw_heavy_local_slot_inherited_lease_is_valid gateway-lifecycle 1; touch "$2"' \
        openclaw-gateway-lifecycle-standard-owner \
        "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh" \
        "$marker"

  [[ -f "$marker" ]] || fail "gateway lifecycle rejected verified standard-owner ancestry"
  [[ ! -e "$lock_path" ]] || fail "standard owner leaked its machine-wide lease"
  pass "gateway lifecycle reuses a verified canonical standard owner"
}

test_gateway_lifecycle_policy_preserves_jarvis_health_for_other_targets() {
  local lock_path="$TMP_DIR/gateway-lifecycle-other-target.lock"
  local health_path="$TMP_DIR/gateway-lifecycle-other-target.health"
  local marker="$TMP_DIR/gateway-lifecycle-other-target.marker"
  local stderr_path="$TMP_DIR/gateway-lifecycle-other-target.err"
  local status=0

  printf 'jarvis-unhealthy\n' >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --policy gateway-lifecycle \
      --label "gateway-restart:ai.openclaw.test" \
      -- \
      "$FIXTURE_ROOT/scripts/gateway-lifecycle-command.sh" cli -- touch "$marker" \
      2>"$stderr_path"
  status=$?
  set -e

  [[ "$status" -eq 75 ]] || fail "unrelated gateway restart ignored unhealthy Jarvis"
  [[ ! -e "$marker" ]] || fail "unrelated gateway restart mutated while Jarvis was unhealthy"
  grep -Fq "code=jarvis_unhealthy" "$stderr_path" ||
    fail "unrelated gateway restart omitted Jarvis health refusal"
  [[ ! -e "$lock_path" ]] || fail "unrelated gateway restart leaked its lease"
  pass "gateway lifecycle preserves Jarvis health for unrelated targets"
}

test_gateway_lifecycle_policy_rejects_unrelated_labels() {
  local lock_path="$TMP_DIR/gateway-lifecycle-invalid-label.lock"
  local health_path="$TMP_DIR/gateway-lifecycle-invalid-label.health"
  local marker="$TMP_DIR/gateway-lifecycle-invalid-label.marker"
  local stderr_path="$TMP_DIR/gateway-lifecycle-invalid-label.err"
  local status=0

  : >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --policy gateway-lifecycle \
      --label "not-a-gateway-restart" \
      -- \
      "$FIXTURE_ROOT/scripts/gateway-lifecycle-command.sh" cli -- touch "$marker" \
      2>"$stderr_path"
  status=$?
  set -e

  [[ "$status" -eq 75 ]] || fail "invalid gateway lifecycle label returned $status instead of 75"
  [[ ! -e "$marker" ]] || fail "invalid gateway lifecycle label reached guarded mutation"
  grep -Fq \
    "HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=invalid_gateway_lifecycle_label" \
    "$stderr_path" ||
    fail "invalid gateway lifecycle label omitted structured refusal"
  [[ ! -e "$lock_path" ]] || fail "invalid gateway lifecycle label created a lease"
  pass "gateway lifecycle policy rejects unrelated labels before mutation"
}

test_gateway_lifecycle_policy_rejects_arbitrary_commands() {
  local lock_path="$TMP_DIR/gateway-lifecycle-invalid-command.lock"
  local health_path="$TMP_DIR/gateway-lifecycle-invalid-command.health"
  local marker="$TMP_DIR/gateway-lifecycle-invalid-command.marker"
  local stderr_path="$TMP_DIR/gateway-lifecycle-invalid-command.err"
  local status=0

  : >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
    "$FIXTURE_WRAPPER" \
      --policy gateway-lifecycle \
      --label "gateway-restart:test-arbitrary-command" \
      -- \
      touch "$marker" \
      2>"$stderr_path"
  status=$?
  set -e

  [[ "$status" -eq 75 ]] || fail "arbitrary gateway lifecycle command returned $status instead of 75"
  [[ ! -e "$marker" ]] || fail "arbitrary gateway lifecycle command reached guarded mutation"
  grep -Fq \
    "HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=invalid_gateway_lifecycle_command" \
    "$stderr_path" ||
    fail "arbitrary gateway lifecycle command omitted structured refusal"
  [[ ! -e "$lock_path" ]] || fail "arbitrary gateway lifecycle command created a lease"
  pass "gateway lifecycle policy rejects arbitrary commands before mutation"
}

test_gateway_lifecycle_command_accepts_only_restart_shape() {
  local fake_bin="$TMP_DIR/gateway-lifecycle-command-bin"
  local fake_node="$fake_bin/node"
  local marker="$TMP_DIR/gateway-lifecycle-command.marker"
  local stderr_path="$TMP_DIR/gateway-lifecycle-command.err"
  local status=0

  mkdir -p "$fake_bin"
  cat >"$fake_node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_MARKER"
EOF
  chmod +x "$fake_node"

  OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_MARKER="$marker" \
    "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" \
      cli -- "$fake_node" "$ROOT_DIR/openclaw.mjs" gateway restart --json
  grep -Fq "$ROOT_DIR/openclaw.mjs gateway restart --json" "$marker" ||
    fail "canonical lifecycle command did not preserve the restart argv"

  OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_MARKER="$marker" \
    "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" \
      cli -- "$fake_node" "$ROOT_DIR/openclaw.mjs" daemon restart --json
  grep -Fq "$ROOT_DIR/openclaw.mjs daemon restart --json" "$marker" ||
    fail "canonical lifecycle command rejected the daemon restart alias"

  : >"$marker"
  set +e
  OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_MARKER="$marker" \
    "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" \
      cli -- "$fake_node" "$ROOT_DIR/openclaw.mjs" gateway status \
      2>"$stderr_path"
  status=$?
  set -e

  [[ "$status" -eq 75 ]] || fail "non-restart lifecycle command returned $status instead of 75"
  [[ ! -s "$marker" ]] || fail "non-restart lifecycle command reached the fake Node mutation"
  grep -Fq "guarded CLI is not a gateway restart command" "$stderr_path" ||
    fail "non-restart lifecycle command omitted its fail-closed reason"

  : >"$marker"
  set +e
  OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_MARKER="$marker" \
    "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" \
      cli -- "$(command -v node)" -e \
      'require("node:fs").writeFileSync(process.env.OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_MARKER, "bypass")' \
      "$ROOT_DIR/openclaw.mjs" gateway restart \
      2>"$stderr_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "Node eval lifecycle bypass returned $status instead of 75"
  [[ ! -s "$marker" ]] || fail "Node eval executed before the decoy canonical entrypoint"
  grep -Fq "guarded command is not this package's OpenClaw CLI" "$stderr_path" ||
    fail "Node eval lifecycle bypass omitted its fail-closed reason"

  set +e
  "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" \
    local-script -- /bin/bash "$TMP_DIR/not-the-canonical-restart-script.sh" \
    2>"$stderr_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "arbitrary local restart script returned $status instead of 75"
  grep -Fq "guarded local restart script is not canonical" "$stderr_path" ||
    fail "arbitrary local restart script omitted its fail-closed reason"
  pass "canonical lifecycle command preserves restart argv and rejects other CLI shapes"
}

test_gateway_lifecycle_handoff_accepts_only_active_custom_label() {
  local fake_bin="$TMP_DIR/gateway-lifecycle-handoff-bin"
  local fake_launchctl="$fake_bin/launchctl"
  local custom_home="$TMP_DIR/gateway-lifecycle-custom-home"
  local custom_label="com.custom.openclaw"
  local other_label="com.other.openclaw"
  local domain="gui/$(id -u)"
  local receipt_dir="$TMP_DIR/openclaw-gateway-lifecycle-$(id -u)-custom"
  local launchctl_log="$TMP_DIR/gateway-lifecycle-handoff.log"
  local watcher_pid=0 watcher_status=0 status=0

  mkdir -p "$fake_bin" "$custom_home/Library/LaunchAgents" "$receipt_dir"
  cat >"$fake_launchctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_LAUNCHCTL_LOG"
EOF
  chmod +x "$fake_launchctl"

  # Admission remains two-phase even in this fixture: acknowledge only after
  # the helper publishes ready, so the launchctl mutation cannot race ahead of
  # its caller's receipt.
  (
    local attempt=0
    while [[ ! -f "$receipt_dir/ready" && "$attempt" -lt 200 ]]; do
      sleep 0.025
      attempt=$((attempt + 1))
    done
    [[ -f "$receipt_dir/ready" ]] || exit 1
    : >"$receipt_dir/ack"
  ) &
  watcher_pid=$!

  HOME="$custom_home" \
  TMPDIR="$TMP_DIR" \
  PATH="$fake_bin:$PATH" \
  OPENCLAW_LAUNCHD_LABEL="$custom_label" \
  OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_LAUNCHCTL_LOG="$launchctl_log" \
    "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" handoff \
      kickstart \
      "$domain/$custom_label" \
      "$domain" \
      "$custom_home/Library/LaunchAgents/$custom_label.plist" \
      0 \
      0 \
      "$receipt_dir" \
      - \
      "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"
  set +e
  wait "$watcher_pid"
  watcher_status=$?
  set -e
  [[ "$watcher_status" -eq 0 ]] || fail "custom-label handoff watcher failed"
  grep -Fq "kickstart -k $domain/$custom_label" "$launchctl_log" ||
    fail "active custom launchd label did not reach the guarded kickstart"
  [[ ! -e "$receipt_dir" ]] || fail "custom-label handoff leaked its receipt directory"

  mkdir -p "$receipt_dir"
  set +e
  HOME="$custom_home" \
  TMPDIR="$TMP_DIR" \
  PATH="$fake_bin:$PATH" \
  OPENCLAW_LAUNCHD_LABEL="$custom_label" \
  OPENCLAW_GATEWAY_LIFECYCLE_FIXTURE_LAUNCHCTL_LOG="$launchctl_log" \
    "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" handoff \
      kickstart \
      "$domain/$other_label" \
      "$domain" \
      "$custom_home/Library/LaunchAgents/$other_label.plist" \
      0 \
      0 \
      "$receipt_dir" \
      - \
      "$ROOT_DIR/scripts/lib/heavy-local-slot.sh" \
      >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "mismatched custom launchd label returned $status instead of 75"
  [[ ! -f "$receipt_dir/ready" ]] || fail "mismatched custom label reached handoff admission"
  pass "gateway lifecycle handoff accepts only the active configured custom label"
}

create_lock_order_fixture() {
  local fixture="$TMP_DIR/lock-order-fixture.sh"

  cat >"$fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

root="$1"
proof_file="$2"
source "$root/scripts/lib/heavy-local-slot.sh"
source "$root/scripts/lib/jarvis-release-lock.sh"

openclaw_heavy_local_slot_require_or_reexec \
  "fleet-release-order" \
  "$root" \
  "$0" \
  "$@"

heavy_path="$(openclaw_heavy_local_slot_resolve_path)"
[[ -f "$heavy_path/owner" ]]
[[ ! -e "$OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE" ]]
openclaw_jarvis_release_lock_acquire "$root" "fleet-release-order"
[[ -f "$heavy_path/owner" ]]
[[ -f "$OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE/owner" ]]
printf 'fleet_then_release\n' >"$proof_file"
EOF
  chmod +x "$fixture"
  printf '%s\n' "$fixture"
}

assert_guard_precedes_mutation() {
  local script="$1"
  local mutation_pattern="$2"
  local guard_line="" mutation_line=""

  guard_line="$(
    grep -n 'openclaw_heavy_local_slot_require_or_reexec' "$ROOT_DIR/$script" |
      head -n 1 |
      cut -d: -f1
  )"
  mutation_line="$(
    grep -nE "$mutation_pattern" "$ROOT_DIR/$script" |
      head -n 1 |
      cut -d: -f1
  )"
  [[ -n "$guard_line" && -n "$mutation_line" && "$guard_line" -lt "$mutation_line" ]] ||
    fail "$script does not acquire the fleet slot before its first live mutation"
}

test_fleet_and_release_lock_coexistence_and_wiring() {
  local fixture="" fleet_lock="$TMP_DIR/order-fleet.lock"
  local release_lock="$TMP_DIR/order-release.lock"
  local health_path="$TMP_DIR/order.health"
  local proof_file="$TMP_DIR/order.proof"
  local script="" guard_line=0 release_line=0

  fixture="$(create_lock_order_fixture)"
  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$fleet_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$release_lock" \
    "$fixture" "$FIXTURE_ROOT" "$proof_file" >/dev/null
  [[ "$(<"$proof_file")" == "fleet_then_release" ]] || fail "lock coexistence proof did not run"
  [[ ! -e "$fleet_lock" && ! -e "$release_lock" ]] || fail "lock-order fixture leaked a lease"

  for script in \
    scripts/ship-jarvis-hotfix.sh \
    scripts/package-openclaw-mac-dist.sh \
    scripts/jarvis-public-release.sh; do
    guard_line="$(
      grep -n 'openclaw_heavy_local_slot_require_or_reexec' "$ROOT_DIR/$script" |
        head -n 1 |
        cut -d: -f1
    )"
    release_line="$(
      grep -n 'openclaw_jarvis_release_lock_acquire' "$ROOT_DIR/$script" |
        head -n 1 |
        cut -d: -f1
    )"
    [[ -n "$guard_line" && -n "$release_line" && "$guard_line" -lt "$release_line" ]] ||
      fail "$script does not enforce fleet -> release lock order"
  done

  for script in \
    scripts/jarvis-release-worktree.sh \
    scripts/bootstrap-open-computer-use-runtime.sh \
    scripts/build-and-run-mac.sh \
    scripts/bundle-a2ui.sh \
    scripts/rebuild-relaunch-consumer-mac-app.sh \
    scripts/relaunch-consumer-mac-ui-smoke.sh \
    scripts/package-consumer-mac-app.sh \
    scripts/package-mac-app.sh \
    scripts/package-mac-dist.sh \
    scripts/open-consumer-mac-app.sh \
    scripts/deploy-shared-main-runtime.sh \
    scripts/gateway-recover-main.sh \
    scripts/restart-mac.sh \
    scripts/ship-main-gateway-fix.sh \
    scripts/build-shared-runtime.sh \
    scripts/package-jarvis-consumer-rc.sh \
    scripts/jarvis-sparkle-update-e2e.sh \
    scripts/prove-jarvis-telegram-runtime.sh \
    scripts/prove-main-telegram-runtime.sh \
    scripts/smoke-main-gateway-restart.sh \
    scripts/telegram-live-runtime.sh \
    scripts/new-worktree.sh \
    scripts/bootstrap-worktree-runtime.sh \
    scripts/prewarm-worktree.sh; do
    grep -Fq 'openclaw_heavy_local_slot_require_or_reexec' "$ROOT_DIR/$script" ||
      fail "$script does not self-enforce the fleet slot"
  done

  # Every newly covered canonical lane must guard before the first operation
  # that can mutate shared runtime state, a worktree, dependencies, or builds.
  assert_guard_precedes_mutation \
    scripts/deploy-shared-main-runtime.sh \
    '^[[:space:]]*run_or_print git -C .* pull --ff-only$'
  assert_guard_precedes_mutation \
    scripts/gateway-recover-main.sh \
    '^[[:space:]]*ensure_gateway_launch_agent_started_or_exit$'
  assert_guard_precedes_mutation \
    scripts/restart-mac.sh \
    '^kill_all_openclaw$'
  assert_guard_precedes_mutation \
    scripts/ship-main-gateway-fix.sh \
    '^[[:space:]]*mark_ready_if_needed "\$\{json\}"$'
  assert_guard_precedes_mutation \
    scripts/build-shared-runtime.sh \
    '^[[:space:]]*openclaw_run_repo_pnpm "\$\{ROOT\}" build$'
  assert_guard_precedes_mutation \
    scripts/package-jarvis-consumer-rc.sh \
    '^[[:space:]]*package_rc_app_fast$'
  assert_guard_precedes_mutation \
    scripts/new-worktree.sh \
    '^if ! git fetch origin; then$'
  assert_guard_precedes_mutation \
    scripts/bootstrap-worktree-runtime.sh \
    '^[[:space:]]*openclaw_run_repo_pnpm "\$ROOT" install --frozen-lockfile$'
  assert_guard_precedes_mutation \
    scripts/prewarm-worktree.sh \
    '^openclaw_run_repo_pnpm "\$ROOT" install --frozen-lockfile$'
  assert_guard_precedes_mutation \
    scripts/bootstrap-open-computer-use-runtime.sh \
    '^[[:space:]]*clone_or_update_checkout$'
  assert_guard_precedes_mutation \
    scripts/build-and-run-mac.sh \
    '^swift build '
  assert_guard_precedes_mutation \
    scripts/bundle-a2ui.sh \
    '^pnpm -s exec tsc '
  # The public release calls bundle-a2ui with no arguments. Keep the re-exec
  # array non-empty so macOS Bash 3.2 nounset mode cannot abort before build.
  grep -Fq 'REEXEC_COMMAND=("$ROOT_DIR/scripts/bundle-a2ui.sh" "$@")' \
    "$ROOT_DIR/scripts/bundle-a2ui.sh" ||
    fail "bundle-a2ui does not seed its zero-argument re-exec command"
  grep -Fq '"${REEXEC_COMMAND[@]}"' "$ROOT_DIR/scripts/bundle-a2ui.sh" ||
    fail "bundle-a2ui does not pass the nounset-safe re-exec command"
  assert_guard_precedes_mutation \
    scripts/relaunch-consumer-mac-ui-smoke.sh \
    '^[[:space:]]*cleanup_ui_smoke_artifacts$'
  assert_guard_precedes_mutation \
    scripts/open-consumer-mac-app.sh \
    '^[[:space:]]*consumer_mac_test_begin_launch '
  assert_guard_precedes_mutation \
    scripts/prove-main-telegram-runtime.sh \
    '^[[:space:]]*bot_json="\$\(resolve_active_bot\)"$'
  assert_guard_precedes_mutation \
    scripts/prove-main-telegram-runtime.sh \
    '^[[:space:]]*run_json telegram-user precheck '
  assert_guard_precedes_mutation \
    scripts/smoke-main-gateway-restart.sh \
    '^[[:space:]]*pre_status="\$\(status_json\)"$'
  assert_guard_precedes_mutation \
    scripts/smoke-main-gateway-restart.sh \
    '^[[:space:]]*confirm_json="\$\(send_user_message '
  assert_guard_precedes_mutation \
    scripts/prove-jarvis-telegram-runtime.sh \
    '^exec "\$JARVIS_NODE" '
  assert_guard_precedes_mutation \
    scripts/jarvis-sparkle-update-e2e.sh \
    '^[[:space:]]*run_preflight$'
  assert_guard_precedes_mutation \
    scripts/jarvis-sparkle-update-e2e.sh \
    '^[[:space:]]*run_apply$'
  assert_guard_precedes_mutation \
    scripts/telegram-live-runtime.sh \
    '^[[:space:]]*ensure_command$'

  # Preview/preflight modes must remain usable while another campaign owns the
  # slot. Each guard is therefore behind an explicit live/apply condition, even
  # though it appears before the live preflight snapshot.
  local live_condition_line=0
  guard_line="$(
    grep -n 'openclaw_heavy_local_slot_require_or_reexec' \
      "$ROOT_DIR/scripts/prove-main-telegram-runtime.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  live_condition_line="$(
    grep -n 'if \[\[ "${DRY_RUN}" != "1" \]\]; then' \
      "$ROOT_DIR/scripts/prove-main-telegram-runtime.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  [[ "$live_condition_line" -lt "$guard_line" ]] ||
    fail "prove-main-telegram-runtime does not condition its live guard"

  guard_line="$(
    grep -n 'openclaw_heavy_local_slot_require_or_reexec' \
      "$ROOT_DIR/scripts/smoke-main-gateway-restart.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  live_condition_line="$(
    grep -n 'if (( DRY_RUN != 1 )); then' \
      "$ROOT_DIR/scripts/smoke-main-gateway-restart.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  [[ "$live_condition_line" -lt "$guard_line" ]] ||
    fail "smoke-main-gateway-restart does not condition its live guard"

  guard_line="$(
    grep -n 'openclaw_heavy_local_slot_require_or_reexec' \
      "$ROOT_DIR/scripts/prove-jarvis-telegram-runtime.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  live_condition_line="$(
    grep -n '"mode":"dry-run"' "$ROOT_DIR/scripts/prove-jarvis-telegram-runtime.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  [[ "$live_condition_line" -lt "$guard_line" ]] ||
    fail "prove-jarvis-telegram-runtime guards its literal dry-run"

  guard_line="$(
    grep -n 'openclaw_heavy_local_slot_require_or_reexec' \
      "$ROOT_DIR/scripts/jarvis-sparkle-update-e2e.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  live_condition_line="$(
    grep -n 'if \[\[ "\$MODE" == "apply" \]\]; then' \
      "$ROOT_DIR/scripts/jarvis-sparkle-update-e2e.sh" |
      head -n 1 |
      cut -d: -f1
  )"
  [[ "$live_condition_line" -lt "$guard_line" ]] ||
    fail "jarvis-sparkle-update-e2e does not condition its apply guard"
  pass "fleet lease precedes release locks and canonical lane mutations"
}

run_suite_test() {
  local test_name="$1"

  SUITE_PHASE="$test_name"
  "$test_name"
}

# The full suite deliberately SIGKILLs disposable wrapper owners. When this
# harness itself runs below the production wrapper, that signal fixture can end
# the outer guarded session before the final static wiring audit. Keep a focused
# mode so callers can prove entrypoint coverage and lock order independently
# without weakening or skipping the full fail-closed tests.
if [[ "${1:-}" == "--wiring-only" ]]; then
  SUITE_PHASE="create_instrumented_runtime"
  create_instrumented_runtime
  run_suite_test test_fleet_and_release_lock_coexistence_and_wiring
  SUITE_PHASE="complete"
  echo "Heavy-local slot wiring tests passed."
  exit 0
fi

if [[ "${1:-}" == "--coordination-only" ]]; then
  SUITE_PHASE="create_instrumented_runtime"
  create_instrumented_runtime
  run_suite_test test_owner_publish_failure_is_actionable
  run_suite_test test_large_generated_state_emits_owner_receipt
  run_suite_test test_disk_pressure_refuses_and_warning_admits
  run_suite_test test_refusal_classes_and_internal_failure_distinction
  run_suite_test test_wait_argument_bounds_fail_before_admission
  run_suite_test test_queue_notice_sanitizes_untrusted_label
  run_suite_test test_occupied_wait_runs_once_with_one_queue_notice
  run_suite_test test_host_health_wait_releases_lease_then_runs_once
  run_suite_test test_deadline_blocks_late_admission
  run_suite_test test_wait_timeout_and_cancel_never_run_command
  SUITE_PHASE="complete"
  echo "Heavy-local slot coordination tests passed."
  exit 0
fi

if [[ "${1:-}" == "--cleanup-only" ]]; then
  SUITE_PHASE="create_instrumented_runtime"
  create_instrumented_runtime
  SUITE_PHASE="create_sigint_reset_launcher"
  create_sigint_reset_launcher
  run_suite_test test_root_exit_kills_term_ignoring_orphan_group
  run_suite_test test_two_sample_health_stop_kills_tree
  run_suite_test test_signal_cleanup_kills_tree_and_releases
  SUITE_PHASE="complete"
  echo "Heavy-local slot cleanup tests passed."
  exit 0
fi

if [[ "${1:-}" == "--cpu-policy-only" ]]; then
  SUITE_PHASE="create_instrumented_runtime"
  create_instrumented_runtime
  SUITE_PHASE="create_sigint_reset_launcher"
  create_sigint_reset_launcher
  run_suite_test test_production_has_no_ambient_test_bypass
  run_suite_test test_cpu_policy_is_explicit_narrow_and_receipted
  run_suite_test test_dedicated_entrypoint_cannot_fall_back_to_standard_cpu_gates
  run_suite_test test_dedicated_entrypoint_injects_only_the_safe_default_wait
  run_suite_test test_dedicated_cpu_policy_preserves_signal_cleanup
  SUITE_PHASE="complete"
  echo "Heavy-local slot CPU policy tests passed."
  exit 0
fi

if [[ "${1:-}" == "--resource-policy-only" ]]; then
  SUITE_PHASE="create_instrumented_runtime"
  create_instrumented_runtime
  run_suite_test test_production_has_no_ambient_test_bypass
  run_suite_test test_reachable_http_errors_keep_their_status
  run_suite_test test_dedicated_resource_guardrails_are_fail_safe_and_observable
  SUITE_PHASE="complete"
  echo "Heavy-local slot dedicated resource tests passed."
  exit 0
fi

if [[ "${1:-}" == "--gateway-lifecycle-only" ]]; then
  SUITE_PHASE="create_instrumented_runtime"
  create_instrumented_runtime
  SUITE_PHASE="create_sigint_reset_launcher"
  create_sigint_reset_launcher
  SUITE_PHASE="create_term_attribution_holder"
  create_term_attribution_holder
  run_suite_test test_machine_wide_default_and_separate_clone_contention
  run_suite_test test_gateway_lifecycle_inherits_verified_standard_owner
  run_suite_test test_gateway_lifecycle_policy_skips_only_gateway_health
  run_suite_test test_gateway_lifecycle_policy_preserves_jarvis_health_for_other_targets
  run_suite_test test_gateway_lifecycle_policy_rejects_unrelated_labels
  run_suite_test test_gateway_lifecycle_policy_rejects_arbitrary_commands
  run_suite_test test_gateway_lifecycle_command_accepts_only_restart_shape
  run_suite_test test_gateway_lifecycle_handoff_accepts_only_active_custom_label
  SUITE_PHASE="complete"
  echo "Gateway lifecycle contention tests passed."
  exit 0
fi

SUITE_PHASE="create_instrumented_runtime"
create_instrumented_runtime
SUITE_PHASE="create_sigint_reset_launcher"
create_sigint_reset_launcher
SUITE_PHASE="create_term_attribution_holder"
create_term_attribution_holder
run_suite_test test_production_has_no_ambient_test_bypass
run_suite_test test_cpu_policy_is_explicit_narrow_and_receipted
run_suite_test test_dedicated_entrypoint_cannot_fall_back_to_standard_cpu_gates
run_suite_test test_dedicated_entrypoint_injects_only_the_safe_default_wait
run_suite_test test_reachable_http_errors_keep_their_status
run_suite_test test_dedicated_resource_guardrails_are_fail_safe_and_observable
run_suite_test test_owner_publish_failure_is_actionable
run_suite_test test_large_generated_state_emits_owner_receipt
run_suite_test test_disk_pressure_refuses_and_warning_admits
run_suite_test test_wrapper_waits_for_explicit_handshake_commit
run_suite_test test_pending_signal_never_executes_guarded_body
run_suite_test test_authoritative_session_identity_ignores_macos_ps_zero
run_suite_test test_persistent_committed_identity_ambiguity_fails_closed
run_suite_test test_hostile_health_environment_cannot_weaken_policy
run_suite_test test_machine_wide_default_and_separate_clone_contention
run_suite_test test_nested_reuse_without_reacquire
run_suite_test test_forged_token_rejected
run_suite_test test_copied_live_token_from_sibling_is_rejected
run_suite_test test_stale_recovery_and_token_safe_cleanup
run_suite_test test_ambiguous_owner_identity_fails_closed
run_suite_test test_child_status_propagation
run_suite_test test_refusal_classes_and_internal_failure_distinction
run_suite_test test_wait_argument_bounds_fail_before_admission
run_suite_test test_queue_notice_sanitizes_untrusted_label
run_suite_test test_occupied_wait_runs_once_with_one_queue_notice
run_suite_test test_host_health_wait_releases_lease_then_runs_once
run_suite_test test_deadline_blocks_late_admission
run_suite_test test_wait_timeout_and_cancel_never_run_command
run_suite_test test_root_exit_kills_term_ignoring_orphan_group
run_suite_test test_wrapper_sigkill_retains_lease_until_orphan_group_dies
run_suite_test test_two_sample_health_stop_kills_tree
run_suite_test test_signal_cleanup_kills_tree_and_releases
run_suite_test test_dedicated_cpu_policy_preserves_signal_cleanup
run_suite_test test_jarvis_remediation_policy_is_narrow_and_non_ambient
run_suite_test test_gateway_lifecycle_inherits_verified_standard_owner
run_suite_test test_gateway_lifecycle_policy_skips_only_gateway_health
run_suite_test test_gateway_lifecycle_policy_preserves_jarvis_health_for_other_targets
run_suite_test test_gateway_lifecycle_policy_rejects_unrelated_labels
run_suite_test test_gateway_lifecycle_policy_rejects_arbitrary_commands
run_suite_test test_gateway_lifecycle_command_accepts_only_restart_shape
run_suite_test test_gateway_lifecycle_handoff_accepts_only_active_custom_label
run_suite_test test_fleet_and_release_lock_coexistence_and_wiring

SUITE_PHASE="complete"
echo "All heavy-local slot tests passed."
