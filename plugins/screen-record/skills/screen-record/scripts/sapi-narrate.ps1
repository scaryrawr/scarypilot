[CmdletBinding(DefaultParameterSetName = "Synthesize")]
param(
    [Parameter(Mandatory, ParameterSetName = "Synthesize")]
    [string]$TextFile,

    [Parameter(Mandatory, ParameterSetName = "Synthesize")]
    [string]$Output,

    [Parameter(ParameterSetName = "Synthesize")]
    [string]$Voice,

    [Parameter(ParameterSetName = "Synthesize")]
    [ValidateRange(-10, 10)]
    [int]$Rate = 0,

    [Parameter(ParameterSetName = "Synthesize")]
    [ValidateRange(0, 100)]
    [int]$Volume = 100,

    [Parameter(Mandatory, ParameterSetName = "List")]
    [switch]$ListVoices
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    if ($ListVoices) {
        $voices = @(
            $synthesizer.GetInstalledVoices() | ForEach-Object {
                [ordered]@{
                    name = $_.VoiceInfo.Name
                    culture = $_.VoiceInfo.Culture.Name
                    gender = $_.VoiceInfo.Gender.ToString()
                    age = $_.VoiceInfo.Age.ToString()
                    enabled = $_.Enabled
                }
            }
        )
        ConvertTo-Json -InputObject $voices -Depth 3
        return
    }

    if (-not [string]::IsNullOrWhiteSpace($Voice)) {
        $synthesizer.SelectVoice($Voice)
    }
    $synthesizer.Rate = $Rate
    $synthesizer.Volume = $Volume
    $synthesizer.SetOutputToWaveFile([System.IO.Path]::GetFullPath($Output))
    $text = [System.IO.File]::ReadAllText(
        [System.IO.Path]::GetFullPath($TextFile),
        [System.Text.Encoding]::UTF8
    )
    $synthesizer.Speak($text)
}
finally {
    $synthesizer.Dispose()
}
