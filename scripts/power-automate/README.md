# Teams PCN card draft

Last updated: 2026-10-07. Status: local draft; Power Automate cloud runtime and Teams rendering unverified.

The existing request remains exactly `{to, subject, message, senderName}`. The email HTML already has the PCN link. These expressions reuse its one approved hyperlink and produce a small Teams card with the same exact PCN destination. No backend, trigger schema, mail action, recipient routing, Teams destination, or connector changes are needed for this draft. No flow has been edited and no messages have been sent.

## Paste setup

In the existing flow, add **Data Operations > Compose** actions in the Teams branch before its card-posting step. Keep the working email branch independent. Rename each Compose to the exact action name below **before** pasting the corresponding file into its **Expression** tab. These files are expressions, without a leading `@` or an `@{...}` wrapper. Do not paste them as quoted JSON or plain text.

| Order | Exact action name | Expression file |
| --- | --- | --- |
| 1 | `Compose_PCN_Message` | [01-message.txt](01-message.txt) |
| 2 | `Compose_PCN_Candidate` | [02-candidate.txt](02-candidate.txt) |
| 3 | `Compose_PCN_Padded` | [03-padded.txt](03-padded.txt) |
| 4 | `Compose_PCN_Link_Valid` | [04-link-valid.txt](04-link-valid.txt) |
| 5 | `Compose_PCN_Kind` | [05-kind.txt](05-kind.txt) |
| 6 | `Compose_PCN_Base_Card` | [06-base-card.txt](06-base-card.txt) |
| 7 | `Compose_PCN_Open_Action` | [07-open-action.txt](07-open-action.txt) |
| 8 | `Compose_PCN_Card` | [08-card.txt](08-card.txt) |

For the current Microsoft Teams **Post card in a chat or channel** action (`PostCardToConversation`), put [09-post-card.txt](09-post-card.txt) in the card payload field's Expression tab. Retain the current connection, **Post as**, **Post in**, chat/team/channel destination, and all routing settings. Do not select a wait-for-response action. If the existing Teams step only posts a plain message, this draft is not a drop-in payload for that field: it requires a card-capable action with the same existing destination and connection. An actual flow change still needs review in the user's flow editor.

The card itself uses `Action.OpenUrl`; opening it continues in the browser and does not submit an approval or update workflow state. Microsoft lists the non-waiting card action in the [Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/#post-card-in-a-chat-or-channel) and describes URL-button support for cards that do not wait in its [Adaptive Cards overview](https://learn.microsoft.com/en-us/power-automate/overview-adaptive-cards). The [official Action.OpenUrl schema](https://adaptivecards.io/explorer/Action.OpenUrl.html) defines the URL and title properties.

## What appears in Teams

| Subject prefix | Card heading | Description | Valid-link button |
| --- | --- | --- | --- |
| `[Action Required] ` | Action required | A PCN is awaiting its assigned reviewer. Open it to see the next action. | Open PCN to take action |
| `[PCN Update] ` | PCN updated | A PCN has been updated. This notice is for your information. | Open PCN |
| Other or configuration test | Supplier PCN notification | A supplier PCN notification was received. | Open PCN only if the email has a valid link |

The existing fixed Teams destination is preserved and may have different members from the email audience. This card does not automatically deliver a private card per email address or mention assigned users. Only the application's assigned reviewer and normal access checks determine who can act.

The card displays the validated PCN code only when the link check succeeds. It never displays raw subject text, HTML, supplier/material/risk/status/department details, recipient emails, or sender names. The subject selects fixed labels only. Missing or malformed links produce no button and no PCN identifier; the card tells the reader to refer to the notification email. [fallback-card.json](fallback-card.json) is a separate static, generic card available for a card field without dynamic expressions.

## Link check and construction

The extraction is deliberately coupled to the current [email template](../../src/notificationTemplate.js): exactly one literal `<a href="https://172.30.77.137:8443/form.html?id=` marker, one double-quoted `href="` attribute, and a closing quote. Only the text between that fixed marker and the closing quote is considered as the candidate PCN code. The candidate must be 13 characters: uppercase `PCN-`, four ASCII digits, `-`, then four ASCII digits. The digit check removes `0` through `9` and requires an empty remainder. Padding makes all `substring` calls safe even for a missing or very short link; validation does not rely on short-circuit evaluation.

When valid, the action URL is rebuilt from the fixed origin/path and the validated code. Arbitrary extracted URLs are never passed through. Other origins, paths, ports, extra query parameters, fragments, escaped/encoded codes, Unicode digit lookalikes, and duplicate double-quoted links fail closed. This is a parser for the trusted, application-generated template, not a general HTML parser, authentication check, or proof that the PCN exists. If the template's hyperlink markup or the configured public origin changes, revise and review the extraction and URL reconstruction together.

Card objects use `setProperty` and `createArray`; dynamic values are never concatenated into JSON strings. `string` serializes the final object for the Teams card field. `createArray` requires at least two values, so the action array uses `take(createArray(action, action), 1)` to retain exactly one button. These functions are documented in Microsoft's [workflow expression reference](https://learn.microsoft.com/en-us/azure/logic-apps/expression-functions-reference), which applies to both Power Automate and Logic Apps.

## Validation and remaining checks

Offline checks parsed the static fallback card and the literal JSON object skeletons, inspected expression delimiters and the Compose dependency order, and reviewed function usage against the primary Microsoft references above. The actual expressions have **not** been executed by a Power Automate runtime. These checks do not prove cloud expression acceptance or card rendering. No live cloud run, message send, connector validation, destination change, or network reachability check has occurred.

The intended next review in the flow editor is to confirm exact internal Compose names, expression acceptance, and the existing card field/destination mapping. Verify cloud output and Teams rendering only under an explicitly authorized test. The `172.30.77.137` address is private; the reader's browser needs the existing network/VPN access and a trusted HTTPS certificate. Opening a PCN still requires the application's normal login and authorization.
