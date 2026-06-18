param(
    [int]$Top = 5,
    [string]$Query = "",
    [string]$Account = "",
    [ValidateSet("recent", "search", "unread")]
    [string]$Mode = "recent",
    [int]$MaxScan = 120
)

$ErrorActionPreference = "Stop"

function Get-InboxForAccount {
    param(
        [Parameter(Mandatory = $true)]
        $Namespace,
        [string]$AccountEmail
    )

    if (-not $AccountEmail -or $AccountEmail.Trim() -eq "") {
        return @{
            Inbox   = $Namespace.GetDefaultFolder(6)
            Account = "padrao"
        }
    }

    $target = $AccountEmail.Trim().ToLower()

    foreach ($account in $Namespace.Accounts) {
        $smtp = [string]$account.SmtpAddress
        if ($smtp.ToLower() -eq $target) {
            $store = $account.DeliveryStore
            if ($store) {
                return @{
                    Inbox   = $store.GetDefaultFolder(6)
                    Account = $smtp
                }
            }
        }
    }

    foreach ($store in $Namespace.Stores) {
        $displayName = [string]$store.DisplayName
        if ($displayName.ToLower().Contains($target)) {
            return @{
                Inbox   = $store.GetDefaultFolder(6)
                Account = $displayName
            }
        }
    }

    foreach ($folder in $Namespace.Folders) {
        $name = [string]$folder.Name
        if ($name.ToLower().Contains($target)) {
            foreach ($inboxName in @("Caixa de Entrada", "Inbox")) {
                try {
                    $inbox = $folder.Folders.Item($inboxName)
                    if ($inbox) {
                        return @{
                            Inbox   = $inbox
                            Account = $name
                        }
                    }
                } catch {
                    continue
                }
            }
        }
    }

    throw "Conta '$AccountEmail' nao encontrada no Outlook. Verifique se esta adicionada e aberta no app."
}

function Test-EmailMatch {
    param(
        $Item,
        [string[]]$Terms
    )

    if ($Terms.Count -eq 0) { return $true }

    $haystack = (
        "$($Item.Subject) $($Item.SenderEmailAddress) $($Item.SenderName)"
    ).ToLower()

    foreach ($term in $Terms) {
        if ($haystack.Contains($term)) {
            return $true
        }
    }

    return $false
}

try {
    $outlook = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
} catch {
    $outlook = New-Object -ComObject Outlook.Application
}

$namespace = $outlook.GetNamespace("MAPI")
$mailbox = Get-InboxForAccount -Namespace $namespace -AccountEmail $Account
$inbox = $mailbox.Inbox
$items = $inbox.Items
$items.Sort("[ReceivedTime]", $true)

$terms = @()
if ($Mode -eq "search" -and $Query -and $Query.Trim() -ne "") {
    $terms = $Query.ToLower().Split(" ", [StringSplitOptions]::RemoveEmptyEntries) |
        Where-Object { $_.Length -gt 2 }
}

if ($Mode -eq "recent" -or $Mode -eq "unread") {
    $MaxScan = [Math]::Min($MaxScan, [Math]::Max($Top * 8, 30))
}

$results = @()
$count = 0
$scanned = 0

$item = $items.GetFirst()
while ($null -ne $item -and $count -lt $Top -and $scanned -lt $MaxScan) {
    $scanned++

    if ($item.Class -eq 43) {
        $include = $true

        if ($Mode -eq "unread" -and -not $item.UnRead) {
            $include = $false
        }

        if ($include -and $Mode -eq "search" -and -not (Test-EmailMatch -Item $item -Terms $terms)) {
            $include = $false
        }

        if ($include) {
            $preview = [string]$item.Body
            if ($preview.Length -gt 400) {
                $preview = $preview.Substring(0, 400)
            }
            $preview = ($preview -replace '\s+', ' ').Trim()

            $from = [string]$item.SenderEmailAddress
            if (-not $from -or $from.Trim() -eq "") {
                $from = [string]$item.SenderName
            }

            $results += [PSCustomObject]@{
                subject = if ($item.Subject) { [string]$item.Subject } else { "(sem assunto)" }
                from    = $from
                date    = $item.ReceivedTime.ToString("o")
                preview = $preview
                isRead  = -not [bool]$item.UnRead
            }

            $count++
        }
    }

    $item = $items.GetNext()
}

$output = [PSCustomObject]@{
    account = $mailbox.Account
    mode    = $Mode
    scanned = $scanned
    emails  = $results
}

$output | ConvertTo-Json -Compress -Depth 4
