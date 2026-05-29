package scripts;

import org.dreambot.api.Client;
import org.dreambot.api.methods.interactive.Players;
import org.dreambot.api.script.AbstractScript;
import org.dreambot.api.script.Category;
import org.dreambot.api.script.ScriptManifest;
import org.dreambot.api.wrappers.interactive.Player;

@ScriptManifest(
  category = Category.UTILITY,
  name = "NeuraL Nick Capture",
  description = "Captures the logged-in character name for Neural Farm Control.",
  author = "NeuraL",
  version = 1.0
)
public class NeuralNickCapture extends AbstractScript {
  private long startedAt;

  @Override
  public void onStart() {
    startedAt = System.currentTimeMillis();
    log("[NFC] nick capture started");
  }

  @Override
  public int onLoop() {
    Player local = Players.getLocal();
    String name = local != null ? local.getName() : "";

    if (Client.isLoggedIn() && name != null && !name.trim().isEmpty()) {
      log("[NFC] charName=" + name.trim());
      stop();
      return 1000;
    }

    if (System.currentTimeMillis() - startedAt > 120000) {
      log("[NFC] nick capture timeout");
      stop();
      return 1000;
    }

    return 1000;
  }
}
