#!/usr/bin/env bash
set -euo pipefail

# WSL must not run dependencies installed by Windows npm. Their launchers select
# node.exe and can reintroduce host credentials or report misleading path errors.
wsl_shell=false
if [[ -r /proc/version ]] && grep -qiE "microsoft|wsl" /proc/version; then
	wsl_shell=true
else
	uname_output="$(uname -a 2>/dev/null || true)"
	if [[ "$uname_output" == *Microsoft* || "$uname_output" == *microsoft* || "$uname_output" == *WSL* ]]; then
		wsl_shell=true
	fi
fi

if [[ "$wsl_shell" == true ]]; then
	node_platform="$(node -p 'process.platform' 2>/dev/null || true)"
	windows_node_modules=false
	if [[ -d node_modules/.bin ]]; then
		for launcher in node_modules/.bin/*.cmd node_modules/.bin/*.ps1; do
			if [[ -f "$launcher" ]]; then
				windows_node_modules=true
				break
			fi
		done
		if [[ "$windows_node_modules" == false ]]; then
			for launcher in node_modules/.bin/*; do
				if [[ -f "$launcher" && ! -L "$launcher" ]] && grep -qE "node\.exe|basedir_win" "$launcher" 2>/dev/null; then
					windows_node_modules=true
					break
				fi
			done
		fi
	fi
	if [[ "$node_platform" == win32 || "$windows_node_modules" == true ]]; then
		printf '%s\n' "WSL test gate requires Linux-native Node and dependencies; Windows-installed node_modules or a Windows Node runtime was detected." >&2
		printf '%s\n' "From this WSL checkout, run: npm ci --ignore-scripts" >&2
		exit 1
	fi
fi

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/aos-agent-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.aos-agent-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/aos-agent-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.aos-agent-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$test_root/home"
	"USERPROFILE=$test_root/home"
	"TMPDIR=$test_root/tmp"
	"TMP=$test_root/tmp"
	"TEMP=$test_root/tmp"
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	"AOS_AGENT_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes.
if [[ "$wsl_shell" != true ]]; then
	for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
		value="${!name-}"
		[[ -z "$value" ]] || test_env+=("$name=$value")
	done
fi

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $test_root/home"
env -i "${test_env[@]}" npm test
