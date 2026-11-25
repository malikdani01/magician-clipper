<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | Google sign-in (Batch 11): the OAuth client the "Continue with
    | Google" button uses. The keys come LATER from the user — until
    | they are set, GoogleAuthController::configured() is false and
    | the button shows the honest "not configured" message instead
    | of attempting a login.
    |
    */

    'google' => [
        'client_id' => env('GOOGLE_CLIENT_ID'),
        'client_secret' => env('GOOGLE_CLIENT_SECRET'),
        'redirect' => env('GOOGLE_REDIRECT_URI'),
    ],

];
