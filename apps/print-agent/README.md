# KatKitchen print agent

Prints kitchen tickets on Wi-Fi and Ethernet receipt printers that the hosted
KatKitchen server cannot reach. It runs on one computer in the restaurant (the
till PC is fine), on the same network as the printers.

- It connects **out** to KatKitchen over HTTPS every 2 seconds. It opens no port,
  and nothing on the internet can connect to it.
- It prints only to the Wi-Fi and Ethernet printers set up for **its branch**, at
  a private address (`192.168.x`, `10.x`, `172.16–31.x`) on port 9100–9109.
- A single file, `katkitchen-print-agent.mjs`, needing Node.js 22 or newer and
  nothing else.

## Set up

1. Manager screens → **Setup → Printers** → **Set up print agent**. Name it after
   the computer, then copy the `agent.json` it shows. **It is shown once.**
2. On the restaurant computer, install Node.js 22 LTS from nodejs.org.
3. Make a folder, e.g. `C:\KatKitchen`. Put `katkitchen-print-agent.mjs` (the
   download link on the same page) and `agent.json` in it.
4. Open PowerShell in that folder and run:

   ```powershell
   node katkitchen-print-agent.mjs --check
   ```

   It lists this branch's Wi-Fi and Ethernet printers and whether each answers.
   It takes no tickets.
5. Start it with Windows (once, in PowerShell **as the user who will be signed in on the till**):

   ```powershell
   $node = (Get-Command node).Source
   $action = New-ScheduledTaskAction -Execute $node -Argument 'katkitchen-print-agent.mjs' -WorkingDirectory 'C:\KatKitchen'
   $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
   Register-ScheduledTask -TaskName 'KatKitchen print agent' -Action $action -Trigger $trigger -Settings $settings
   Start-ScheduledTask -TaskName 'KatKitchen print agent'
   ```

   Within a few seconds the Printers page shows the agent as **Online**.
6. On the Printers page, **Test print** on each printer.

Keep `agent.json` private: it is the agent's password. To restrict it to the
current user: `icacls agent.json /inheritance:r /grant:r "$($env:USERNAME):R"`.

## When something is wrong

| What you see | What to do |
|---|---|
| Printers page: "No print agent is running" | The program is not running, or this computer is off or offline. Start it, or check the scheduled task |
| The agent prints `The server refused this agent token` and stops | The agent was stopped on the Printers page, or the token is wrong. Set up a new agent and replace `agent.json` |
| A printer "does not answer" | Check it is on and connected. From this computer: `Test-NetConnection 192.168.1.50 -Port 9100`. Give the printer a fixed address in the router |
| Tickets wait and never print | While a branch has a print agent, the server leaves that branch's tickets to it. They print when it is running again |

## Stopping it

On the Printers page, **Stop this agent**. It is refused at its next check, and
any tickets it was holding go back to the queue. Then remove the scheduled task:
`Unregister-ScheduledTask -TaskName 'KatKitchen print agent'`.
