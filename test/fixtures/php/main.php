<?php
require_once("quicktype.php");

$f = file_get_contents($argv[1]);

$h = new TopLevelHydrator();

$out = json_encode(
    $h->hydrate(
        $h->dehydrate(
            json_decode($f, true)
        )
    )
);

echo($out);