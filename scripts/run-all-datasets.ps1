#requires -Version 5.1
<#
.SYNOPSIS
  Runs the CopilotConnectorWorkflow pipeline (steps 1-5, NO scoring) against every
  dataset folder in .\data and copies the artifacts to .\output\<dataset-name>\.

.DESCRIPTION
  Step 6 (m365eval / scoring) is automatically skipped because we always use
  --mode build (orchestrator.ts only includes m365eval when runM365Eval &&
  mode == 'provision'). Steps executed per dataset:
    1. evalgen   - eval-gen against the dataset
    2. enhance   - data-enhancer python script
    3. schema    - Graph schema hardening + validation
    4. connector - scaffold Azure Functions project + tsc
    5. deploy    - emit Azure Functions + Container Apps deploy artifacts

  Datasets are processed sequentially. Failures are logged but do not abort the
  loop. A per-run summary is written to output\_run-summary.csv.

.PARAMETER Only
  Optional comma-separated list of dataset names to limit the run to.

.PARAMETER Skip
  Optional comma-separated list of dataset names to exclude.

.PARAMETER Count
  Number of eval prompts per dataset (5-50, default 30).

.EXAMPLE
  scripts\run-all-datasets.ps1
  scripts\run-all-datasets.ps1 -Only ngo-environment,ngo-energy
  scripts\run-all-datasets.ps1 -Skip hls-pubmed,hls-biorxiv
#>
[CmdletBinding()]
param(
  [string[]] $Only = @(),
  [string[]] $Skip = @(),
  [ValidateRange(5, 50)] [int] $Count = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path 'dist\cli.js')) {
  Write-Host '[setup] building workflow...' -ForegroundColor Cyan
  npm run build | Out-Host
}

$outputRoot = Join-Path $repoRoot 'output'
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$summaryCsv = Join-Path $outputRoot '_run-summary.csv'
if (-not (Test-Path $summaryCsv)) {
  'datasetName,jobId,status,startedAt,endedAt,durationSec,outputPath,errorMessage' |
    Out-File -FilePath $summaryCsv -Encoding utf8
}

# Map: dataset folder name -> { description, connectorId, connectorName, extensions, preprocess }.
# - description sourced from <ds>\*\eval-set-review.md when present (NGO datasets).
# - HLS datasets have no eval-set-review.md so descriptions are hand-written
#   based on each dataset's manifest.json + public knowledge of the source.
# - connectorId must match ^[a-zA-Z0-9]{3,128}$ - dashes removed.
# - extensions tells eval-gen (step 1) and the data-enhancer (step 2) which
#   file types to ingest. The data-enhancer is CSV-only (csv.DictReader);
#   it cannot parse JSONL/JSON, so HLS datasets must be pre-flattened to CSV
#   via scripts\jsonl-to-csv.py before the pipeline runs. NGO datasets ship
#   CSVs already; their .json files are auxiliary API responses and are
#   intentionally excluded.
# - preprocess: 'jsonl-to-csv' | $null - if set, the runner first converts
#   the dataset's records.jsonl into a staging CSV folder, then runs the
#   pipeline against that staged folder instead of the raw dataset.
$datasets = @(
  # ---------- Healthcare / Life Sciences ----------
  # maxRows caps the row count in the staged CSV so eval-gen can read the file
  # into a single JS string (Node's max string length is ~512 MB). Datasets
  # above that threshold are sampled deterministically (every Nth row).
  @{ name='hls-biorxiv';        id='hlsbiorxiv';        display='HLS bioRxiv';        ext='csv'; preprocess='jsonl-to-csv'; maxRows=50000;
     desc='bioRxiv biology preprint records including title abstract authors DOI posting date and category covering life sciences research publications.' },
  @{ name='hls-chembl';         id='hlschembl';         display='HLS ChEMBL';         ext='csv'; preprocess='jsonl-to-csv'; maxRows=50000;
     desc='ChEMBL bioactivity records including compound molecule structures targets assays activities and standard values for drug discovery research.' },
  @{ name='hls-clinicaltrials'; id='hlsclinicaltrials'; display='HLS ClinicalTrials'; ext='csv'; preprocess='jsonl-to-csv'; maxRows=50000;
     desc='ClinicalTrials.gov registry entries including NCT identifier study title conditions interventions phase status sponsors and enrollment data.' },
  @{ name='hls-cms';            id='hlscms';            display='HLS CMS';            ext='csv'; preprocess='jsonl-to-csv'; maxRows=0;
     desc='Centers for Medicare and Medicaid Services public datasets including provider utilization payments and quality metrics across US healthcare programs.' },
  @{ name='hls-icd10';          id='hlsicd10';          display='HLS ICD-10';         ext='csv'; preprocess='jsonl-to-csv'; maxRows=0;
     desc='ICD-10 medical classification codes with category descriptions hierarchical chapter groupings and clinical diagnosis terminology.' },
  @{ name='hls-npi';            id='hlsnpi';            display='HLS NPI';            ext='csv'; preprocess='jsonl-to-csv'; maxRows=0;
     desc='National Provider Identifier registry of US healthcare providers including NPI number organization or individual names taxonomy practice address and credentials.' },
  @{ name='hls-pubmed';         id='hlspubmed';         display='HLS PubMed';         ext='csv'; preprocess='jsonl-to-csv'; maxRows=50000;
     desc='PubMed biomedical literature citations including PMID title abstract authors journal publication year MeSH terms and DOI from the National Library of Medicine.' },

  # ---------- NGO sector datasets ----------
  @{ name='ngo-agriculture';    id='ngoagriculture';    display='NGO Agriculture';    ext='csv'; preprocess=$null; maxRows=0;
     desc='Agricultural production crop yields livestock food security and undernourishment indicators from FAO World Bank and OWID covering countries and years.' },
  @{ name='ngo-aidfunding';     id='ngoaidfunding';     display='NGO Aid Funding';    ext='csv'; preprocess=$null; maxRows=0;
     desc='Foreign aid Official Development Assistance ODA disbursements and IATI publisher metadata from World Bank and IATI Registry covering donor and recipient countries.' },
  @{ name='ngo-childprotection';id='ngochildprotection';display='NGO Child Protection'; ext='csv'; preprocess=$null; maxRows=0;
     desc='Child protection and welfare indicators including child mortality stunting child labor and birth registration from World Bank and OWID by country and year.' },
  @{ name='ngo-conflict';       id='ngoconflict';       display='NGO Conflict';       ext='csv'; preprocess=$null; maxRows=0;
     desc='Armed conflict crime and violence indicators including intentional homicide rates and military expenditure from World Bank ACLED UCDP and UNODC by country and year.' },
  @{ name='ngo-economics';      id='ngoeconomics';      display='NGO Economics';      ext='csv'; preprocess=$null; maxRows=0;
     desc='Economic indicators including GDP per capita poverty Gini inequality unemployment and Human Development Index from World Bank UNDP and OWID by country and year.' },
  @{ name='ngo-education';      id='ngoeducation';      display='NGO Education';      ext='csv'; preprocess=$null; maxRows=0;
     desc='Education indicators including primary secondary tertiary enrollment literacy rates and expenditure on education from World Bank and OWID by country and year.' },
  @{ name='ngo-energy';         id='ngoenergy';         display='NGO Energy';         ext='csv'; preprocess=$null; maxRows=0;
     desc='Energy access electricity consumption renewable share and energy use indicators from World Bank and OWID Energy Data covering countries and years.' },
  @{ name='ngo-environment';    id='ngoenvironment';    display='NGO Environment';    ext='csv'; preprocess=$null; maxRows=0;
     desc='Environmental indicators including CO2 emissions greenhouse gases forest area air pollution and protected areas from World Bank and OWID by country and year.' },
  @{ name='ngo-gender';         id='ngogender';         display='NGO Gender';         ext='csv'; preprocess=$null; maxRows=0;
     desc='Gender indicators from the World Bank covering women participation in parliaments labor force participation rates fertility rates maternal health and educational parity across countries.' },
  @{ name='ngo-healthcare';     id='ngohealthcare';     display='NGO Healthcare';     ext='csv'; preprocess=$null; maxRows=0;
     desc='Health indicators including life expectancy under-five mortality maternal mortality immunization coverage and health expenditure from WHO Global Health Observatory and World Bank by country and year.' },
  @{ name='ngo-humanitarian';   id='ngohumanitarian';   display='NGO Humanitarian';   ext='csv'; preprocess=$null; maxRows=0;
     desc='IFRC GO emergency events ReliefWeb appeals and HDX humanitarian indicators including disaster type affected populations beneficiaries amount requested and amount funded across countries.' },
  @{ name='ngo-humanrights';    id='ngohumanrights';    display='NGO Human Rights';   ext='csv'; preprocess=$null; maxRows=0;
     desc='Governance and human rights indicators including the six Worldwide Governance Indicators Freedom House scores Transparency International CPI and rule of law from World Bank by country and year.' },
  @{ name='ngo-multisector';    id='ngomultisector';    display='NGO Multisector';    ext='csv'; preprocess=$null; maxRows=0;
     desc='Cross-cutting Sustainable Development Goal indicators spanning poverty health education water energy gender and demographics from World Bank and OWID by country and year.' },
  @{ name='ngo-nonprofit';      id='ngononprofit';      display='NGO Nonprofit';      ext='csv'; preprocess=$null; maxRows=0;
     desc='US nonprofit organization data from ProPublica Nonprofit Explorer and UK Charity Commission including EIN names NTEE category state revenue expenses and Form 990 filings.' },
  @{ name='ngo-refugees';       id='ngorefugees';       display='NGO Refugees';       ext='csv'; preprocess=$null; maxRows=0;
     desc='Refugee asylum-seeker IDP and stateless population data from UNHCR by country of origin and country of asylum plus migration and remittance indicators from World Bank.' },
  @{ name='ngo-wash';           id='ngowash';           display='NGO WASH';           ext='csv'; preprocess=$null; maxRows=0;
     desc='WASH water sanitation and hygiene indicators from World Bank and OWID covering drinking water sanitation and handwashing services across countries by year.' }
)

if ($Only.Count -gt 0) {
  $datasets = @($datasets | Where-Object { $Only -contains $_.name })
}
if ($Skip.Count -gt 0) {
  $datasets = @($datasets | Where-Object { $Skip -notcontains $_.name })
}

Write-Host ("[plan] {0} dataset(s) queued" -f $datasets.Count) -ForegroundColor Cyan
$datasets | ForEach-Object { Write-Host ("  - {0}" -f $_.name) }

$overallStart = Get-Date

foreach ($d in $datasets) {
  $rawDatasetPath = Join-Path $repoRoot ('data\' + $d.name)
  $datasetPath    = $rawDatasetPath
  $outputDir      = Join-Path $outputRoot $d.name
  $logFile        = Join-Path $outputRoot ($d.name + '.log')
  $startedAt      = Get-Date

  Write-Host ''
  Write-Host ('=' * 80)
  Write-Host ("[{0}] starting at {1}" -f $d.name, $startedAt.ToString('s')) -ForegroundColor Yellow
  Write-Host ('=' * 80)

  if (-not (Test-Path $rawDatasetPath)) {
    Write-Warning ("[{0}] dataset path missing: {1}" -f $d.name, $rawDatasetPath)
    continue
  }
  if (Test-Path (Join-Path $outputDir 'job.json')) {
    Write-Host ("[{0}] already has output at {1}, skipping. Delete the folder to re-run." -f $d.name, $outputDir) -ForegroundColor DarkGray
    continue
  }

  # Optional preprocess: flatten JSONL -> CSV in workspace\staged\<name>\ so the
  # data-enhancer (which only reads CSV/TSV) can ingest HLS datasets.
  if ($d.preprocess -eq 'jsonl-to-csv') {
    $stagedDir = Join-Path $repoRoot ('workspace\staged\' + $d.name)
    $stagedCsv = Join-Path $stagedDir 'records.csv'
    if (-not (Test-Path $stagedCsv)) {
      $jsonl = Join-Path $rawDatasetPath 'full\records.jsonl'
      if (-not (Test-Path $jsonl)) {
        Write-Warning ("[{0}] expected records.jsonl not found: {1}" -f $d.name, $jsonl)
        continue
      }
      New-Item -ItemType Directory -Force -Path $stagedDir | Out-Null
      $maxRows = if ($d.ContainsKey('maxRows')) { [int]$d.maxRows } else { 0 }
      $preArgs = @((Join-Path $PSScriptRoot 'jsonl-to-csv.py'), $jsonl, $stagedCsv)
      if ($maxRows -gt 0) { $preArgs += @('--max-rows', [string]$maxRows) }
      Write-Host ("[{0}] preprocessing JSONL -> CSV (max-rows={1}): {2}" -f $d.name, $maxRows, $stagedCsv) -ForegroundColor Cyan
      $convertStart = Get-Date
      & python @preArgs
      if ($LASTEXITCODE -ne 0) {
        Write-Warning ("[{0}] preprocessing failed (exit {1})" -f $d.name, $LASTEXITCODE)
        continue
      }
      Write-Host ("[{0}] preprocess done in {1:N0}s" -f $d.name, ((Get-Date) - $convertStart).TotalSeconds) -ForegroundColor Cyan
    } else {
      Write-Host ("[{0}] using cached staged CSV: {1}" -f $d.name, $stagedCsv) -ForegroundColor DarkGray
    }
    $datasetPath = $stagedDir
  }

  $cliArgs = @(
    'dist\cli.js', 'run',
    '--dataset',         $datasetPath,
    '--description',     $d.desc,
    '--count',           [string]$Count,
    '--extensions',      $d.ext,
    '--connector-id',    $d.id,
    '--connector-name',  $d.display,
    '--deploy-target',   'both',
    '--mode',            'build'
  )

  # Capture stdout (so we can grep for the job id) while still streaming to console.
  # Using the call operator with array splatting preserves args with spaces;
  # Start-Process -ArgumentList does not.
  Write-Host ('  cmd: node ' + ($cliArgs -join ' ')) -ForegroundColor DarkGray
  $combined = & node @cliArgs 2>&1
  $exit = $LASTEXITCODE
  $stdout = ($combined | Out-String)
  Write-Host $stdout
  $stdout | Out-File -FilePath $logFile -Encoding utf8

  $jobId = $null
  if ($stdout -match 'Created job (\S+)') { $jobId = $Matches[1] }

  $endedAt    = Get-Date
  $durationSec = [int]($endedAt - $startedAt).TotalSeconds
  $status     = if ($exit -eq 0) { 'done' } else { 'failed' }
  $errMsg     = ''
  $jobOutputDir = ''

  if ($jobId) {
    $jobDir = Join-Path $repoRoot ('workspace\jobs\' + $jobId)
    if (Test-Path $jobDir) {
      New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
      Write-Host ("[{0}] copying {1} -> {2}" -f $d.name, $jobDir, $outputDir)
      Copy-Item -Path (Join-Path $jobDir '*') -Destination $outputDir -Recurse -Force
      $jobOutputDir = $outputDir
    } else {
      $errMsg = 'jobDir not found: ' + $jobDir
    }
  } else {
    $errMsg = 'no job id captured (cli failed before createJob)'
  }
  if ($exit -ne 0 -and -not $errMsg) { $errMsg = "cli exit $exit" }

  # CSV-safe quote
  function Quote([string]$s) { '"' + ($s -replace '"', '""') + '"' }
  $row = @(
    (Quote $d.name),
    (Quote ([string]$jobId)),
    (Quote $status),
    (Quote $startedAt.ToString('s')),
    (Quote $endedAt.ToString('s')),
    [string]$durationSec,
    (Quote $jobOutputDir),
    (Quote $errMsg)
  ) -join ','
  Add-Content -Path $summaryCsv -Value $row

  $color = if ($status -eq 'done') { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1} in {2}s (job {3})" -f $d.name, $status, $durationSec, $jobId) -ForegroundColor $color
}

$overallEnd = Get-Date
Write-Host ''
Write-Host ('=' * 80)
Write-Host ("All runs complete in {0:N0}s. Summary: {1}" -f ($overallEnd - $overallStart).TotalSeconds, $summaryCsv) -ForegroundColor Cyan
Write-Host ('=' * 80)
